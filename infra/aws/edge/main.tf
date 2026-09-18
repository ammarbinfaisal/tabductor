terraform {
  required_version = "~> 1.13.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.62.0" }
  }
  backend "s3" {}
}
provider "aws" {
  region              = "ap-southeast-2"
  allowed_account_ids = ["523227112806"]
  default_tags { tags = { Project = "tabductor", Environment = "staging", ManagedBy = "terraform" } }
}
data "terraform_remote_state" "foundation" {
  backend = "s3"
  config = {
    bucket = "tabductor-staging-523227112806-ap-southeast-2-terraform"
    key    = "foundation/terraform.tfstate"
    region = "ap-southeast-2"
  }
}
locals { foundation = data.terraform_remote_state.foundation.outputs.deployment }
data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [local.foundation.vpc_id]
  }
  tags = { "karpenter.sh/discovery" = "tabductor-staging" }
}
data "aws_ec2_managed_prefix_list" "cloudfront" { name = "com.amazonaws.global.cloudfront.origin-facing" }
resource "aws_security_group" "edge" {
  name   = "tabductor-staging-private-ingress"
  vpc_id = local.foundation.vpc_id
  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }
  egress {
    from_port       = 8081
    to_port         = 8081
    protocol        = "tcp"
    security_groups = [local.foundation.node_security_group_id]
  }
}
resource "aws_security_group_rule" "node_ingress" {
  type                     = "ingress"
  security_group_id        = local.foundation.node_security_group_id
  source_security_group_id = aws_security_group.edge.id
  from_port                = 8081
  to_port                  = 8081
  protocol                 = "tcp"
}
resource "aws_lb" "gateway" {
  name                       = "tabductor-staging"
  internal                   = true
  load_balancer_type         = "application"
  subnets                    = data.aws_subnets.private.ids
  security_groups            = [aws_security_group.edge.id]
  idle_timeout               = 180
  drop_invalid_header_fields = true
}
resource "aws_lb_target_group" "gateway" {
  name                 = "tabductor-staging-gateway"
  port                 = 8081
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = local.foundation.vpc_id
  deregistration_delay = 30
  health_check { path = "/healthz" }
}
resource "aws_lb_listener" "gateway" {
  load_balancer_arn = aws_lb.gateway.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}
resource "aws_cloudfront_vpc_origin" "gateway" {
  vpc_origin_endpoint_config {
    name                   = "tabductor-staging"
    arn                    = aws_lb.gateway.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
  depends_on = [aws_lb_listener.gateway]
}
data "aws_cloudfront_cache_policy" "disabled" { name = "Managed-CachingDisabled" }
data "aws_cloudfront_origin_request_policy" "viewer" { name = "Managed-AllViewer" }
resource "aws_cloudfront_distribution" "gateway" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Tabductor staging HTTPS and browser WebSocket gateway"
  price_class     = "PriceClass_All"
  origin {
    domain_name = aws_lb.gateway.dns_name
    origin_id   = "private-gateway"
    vpc_origin_config {
      vpc_origin_id            = aws_cloudfront_vpc_origin.gateway.id
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
  }
  default_cache_behavior {
    target_origin_id         = "private-gateway"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.viewer.id
    compress                 = true
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate { cloudfront_default_certificate = true }
}
output "url" { value = "https://${aws_cloudfront_distribution.gateway.domain_name}" }
output "target_group_arn" { value = aws_lb_target_group.gateway.arn }
