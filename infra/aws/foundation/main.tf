terraform {
  required_version = "~> 1.13.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.62.0" }
  }
  backend "s3" {}
}
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags { tags = { Project = "tabductor", Environment = "staging", ManagedBy = "terraform" } }
}
variable "region" { default = "ap-southeast-2" }
variable "account_id" { default = "523227112806" }
variable "name" { default = "tabductor-staging" }
variable "operator_cidr" {
  type        = string
  description = "Operator public IPv4 /32 allowed to reach the authenticated EKS API."
}
data "aws_availability_zones" "available" { state = "available" }
locals { azs = slice(data.aws_availability_zones.available.names, 0, 2) }
module "vpc" {
  source               = "terraform-aws-modules/vpc/aws"
  version              = "6.7.2"
  name                 = var.name
  cidr                 = "10.72.0.0/16"
  azs                  = local.azs
  private_subnets      = ["10.72.0.0/20", "10.72.16.0/20"]
  public_subnets       = ["10.72.128.0/24", "10.72.129.0/24"]
  database_subnets     = ["10.72.160.0/24", "10.72.161.0/24"]
  enable_nat_gateway   = true
  single_nat_gateway   = true
  enable_dns_hostnames = true
  public_subnet_tags   = { "kubernetes.io/role/elb" = "1" }
  private_subnet_tags  = { "kubernetes.io/role/internal-elb" = "1", "karpenter.sh/discovery" = var.name }
}
module "eks" {
  source                                   = "terraform-aws-modules/eks/aws"
  version                                  = "21.25.0"
  name                                     = var.name
  kubernetes_version                       = "1.34"
  endpoint_public_access                   = true
  endpoint_public_access_cidrs             = [var.operator_cidr]
  endpoint_private_access                  = true
  enable_cluster_creator_admin_permissions = true
  enable_irsa                              = false
  vpc_id                                   = module.vpc.vpc_id
  subnet_ids                               = module.vpc.private_subnets
  addons = {
    coredns                = {}
    kube-proxy             = {}
    eks-pod-identity-agent = { before_compute = true }
    vpc-cni = {
      before_compute       = true
      configuration_values = jsonencode({ enableNetworkPolicy = "true", env = { NETWORK_POLICY_ENFORCING_MODE = "strict" } })
    }
  }
  eks_managed_node_groups = {
    baseline = {
      instance_types   = ["m6i.large"]
      ami_type         = "AL2023_x86_64_STANDARD"
      min_size         = 2
      max_size         = 3
      desired_size     = 2
      labels           = { "tabductor.io/node-role" = "control", "karpenter.sh/controller" = "true" }
      metadata_options = { http_endpoint = "enabled", http_tokens = "required", http_put_response_hop_limit = 1 }
    }
  }
  node_security_group_tags = { "karpenter.sh/discovery" = var.name }
}
module "karpenter" {
  source                          = "terraform-aws-modules/eks/aws//modules/karpenter"
  version                         = "21.25.0"
  cluster_name                    = module.eks.cluster_name
  node_iam_role_use_name_prefix   = false
  node_iam_role_name              = "${var.name}-browser"
  create_pod_identity_association = true
  enable_inline_policy            = true
}
resource "aws_kms_key" "application" {
  description             = "Tabductor staging envelope keys and object encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  lifecycle { prevent_destroy = true }
}
resource "aws_kms_alias" "application" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.application.key_id
}
resource "aws_s3_bucket" "blobs" {
  bucket = "${var.name}-${var.account_id}-${var.region}-blobs"
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "blobs" {
  bucket                  = aws_s3_bucket.blobs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "blobs" {
  bucket = aws_s3_bucket.blobs.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.application.arn
    }
  }
}
resource "aws_s3_bucket_versioning" "blobs" {
  bucket = aws_s3_bucket.blobs.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_lifecycle_configuration" "blobs" {
  bucket = aws_s3_bucket.blobs.id
  rule {
    id     = "retire-deleted-media"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 1 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}
resource "aws_s3_bucket_policy" "blobs" {
  bucket = aws_s3_bucket.blobs.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.blobs.arn, "${aws_s3_bucket.blobs.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
resource "aws_ecr_repository" "images" {
  for_each             = toset(["app", "browser-worker"])
  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}
resource "aws_security_group" "database" {
  name_prefix = "${var.name}-postgres-"
  vpc_id      = module.vpc.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}
resource "aws_db_parameter_group" "postgres" {
  name   = "${var.name}-postgres16"
  family = "postgres16"
  parameter {
    apply_method = "pending-reboot"
    name         = "rds.force_ssl"
    value        = "1"
  }
}
resource "aws_db_instance" "postgres" {
  identifier                      = var.name
  engine                          = "postgres"
  engine_version                  = "16"
  instance_class                  = "db.t4g.small"
  allocated_storage               = 30
  max_allocated_storage           = 100
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.application.arn
  db_name                         = "tabductor"
  username                        = "tabductor_admin"
  manage_master_user_password     = true
  master_user_secret_kms_key_id   = aws_kms_key.application.arn
  db_subnet_group_name            = module.vpc.database_subnet_group_name
  vpc_security_group_ids          = [aws_security_group.database.id]
  parameter_group_name            = aws_db_parameter_group.postgres.name
  publicly_accessible             = false
  multi_az                        = false
  backup_retention_period         = 1
  copy_tags_to_snapshot           = true
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.name}-final"
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  lifecycle { prevent_destroy = true }
}
resource "aws_secretsmanager_secret" "application" {
  name                    = "${var.name}/application"
  kms_key_id              = aws_kms_key.application.arn
  recovery_window_in_days = 30
}
data "aws_iam_policy_document" "pod_assume" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "application" {
  name               = "${var.name}-application"
  assume_role_policy = data.aws_iam_policy_document.pod_assume.json
}
resource "aws_iam_role_policy" "application" {
  role = aws_iam_role.application.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = ["${aws_s3_bucket.blobs.arn}/*"] },
    { Effect = "Allow", Action = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"], Resource = [aws_kms_key.application.arn] }
  ] })
}
resource "aws_eks_pod_identity_association" "application" {
  for_each        = toset(["staging-tabductor-app", "staging-tabductor-fleet"])
  cluster_name    = module.eks.cluster_name
  namespace       = var.name
  service_account = each.key
  role_arn        = aws_iam_role.application.arn
}
output "deployment" {
  value = {
    region                 = var.region
    account_id             = var.account_id
    cluster_name           = module.eks.cluster_name
    cluster_endpoint       = module.eks.cluster_endpoint
    vpc_id                 = module.vpc.vpc_id
    public_subnets         = module.vpc.public_subnets
    node_security_group_id = module.eks.node_security_group_id
    database_host          = aws_db_instance.postgres.address
    database_secret_arn    = aws_db_instance.postgres.master_user_secret[0].secret_arn
    application_secret_arn = aws_secretsmanager_secret.application.arn
    kms_key_arn            = aws_kms_key.application.arn
    blob_bucket            = aws_s3_bucket.blobs.id
    image_repositories     = { for k, v in aws_ecr_repository.images : k => v.repository_url }
    browser_node_role      = module.karpenter.node_iam_role_name
    karpenter_queue        = module.karpenter.queue_name
  }
}
