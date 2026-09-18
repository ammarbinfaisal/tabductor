resource "aws_iam_role" "load_balancer" {
  name               = "${var.name}-load-balancer"
  assume_role_policy = data.aws_iam_policy_document.pod_assume.json
}
resource "aws_iam_role_policy" "load_balancer" {
  role   = aws_iam_role.load_balancer.id
  policy = file("${path.module}/load-balancer-policy.json")
}
resource "aws_eks_pod_identity_association" "load_balancer" {
  cluster_name    = module.eks.cluster_name
  namespace       = "kube-system"
  service_account = "aws-load-balancer-controller"
  role_arn        = aws_iam_role.load_balancer.arn
}
