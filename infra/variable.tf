variable "aws_project" {
  description = "The AWS project name."
  type        = string
  default     = "coding-workshop"
}

variable "aws_bucket" {
  description = "The AWS S3 bucket name for terraform state storage."
  type        = string
  default     = "coding-workshop-us-east-1-abcd1234"
}

variable "aws_app_code" {
  description = "The AWS application unique code."
  type        = string
  default     = "abcd1234"
}

variable "aws_ds_ip" {
  description = "The AWS Directory Service ip address."
  type        = string
  default     = ""
}

variable "aws_vpc_id" {
  description = "The AWS VPC identifier."
  type        = string
  default     = null
}

variable "aws_postgres_enabled" {
  description = "Enable or disable PostgreSQL (AWS Aurora). Default: true (set to 'false' to disable it)."
  type        = bool
  default     = true

  validation {
    condition     = contains([true, false], var.aws_postgres_enabled)
    error_message = "The aws_postgres_enabled variable must be either 'true' or 'false'."
  }
}

variable "aws_postgres_host" {
  description = "PostgreSQL host for LocalStack. Default: 'host.docker.internal' (set to '172.17.0.1' on Linux)."
  type        = string
  default     = null
}

variable "aws_mongo_enabled" {
  description = "Enable or disable MongoDB (AWS DocumentDB). Default: false (set to 'true' to enable it)."
  type        = bool
  default     = false

  validation {
    condition     = contains([true, false], var.aws_mongo_enabled)
    error_message = "The aws_mongo_enabled variable must be either 'true' or 'false'."
  }
}

variable "aws_mongo_host" {
  description = "MongoDB host for LocalStack. Default: 'host.docker.internal' (set to '172.17.0.1' on Linux)."
  type        = string
  default     = null
}

variable "aws_eks_enabled" {
  description = "Enable or disable Jupyter Notebook (AWS EKS). Default: false (set to 'true' to enable it)."
  type        = bool
  default     = false

  validation {
    condition     = contains([true, false], var.aws_eks_enabled)
    error_message = "The aws_eks_enabled variable must be either 'true' or 'false'."
  }
}

variable "aws_eks_type" {
  description = "EKS nodes type. Default: SPOT."
  type        = string
  default     = "SPOT"

  validation {
    condition     = contains(["ON_DEMAND", "SPOT"], var.aws_eks_type)
    error_message = "The aws_eks_type variable must be either 'ON_DEMAND' or 'SPOT'."
  }
}

# Never put the value in a tracked file. Type it at a prompt instead, so it is in no file
# and not in shell history (run from the project root):
#   ( IFS= read -rsp 'Admin password: ' TF_VAR_seed_admin_password && export TF_VAR_seed_admin_password && ./bin/deploy-backend.sh )
# Then open the site once: the auth service creates the admin on its first request, and
# only when no admin exists yet, so the value is needed for that one deploy only.
variable "seed_admin_password" {
  description = "Password for the first admin account (admin@acme.inc), created by the auth service when no admin exists yet. Empty: no admin is created."
  type        = string
  default     = ""
  sensitive   = true

  # Same rules backend/auth/function.py applies; a password it rejects would create no admin
  validation {
    condition = var.seed_admin_password == "" || (
      length(var.seed_admin_password) >= 8 &&
      length(base64encode(var.seed_admin_password)) <= 96 && # 96 base64 characters = 72 bytes
      can(regex("[A-Za-z]", var.seed_admin_password)) &&
      can(regex("[0-9]", var.seed_admin_password)) &&
      !can(regex("[[:cntrl:]]", var.seed_admin_password)) &&
      var.seed_admin_password == trimspace(var.seed_admin_password)
    )
    error_message = "The seed_admin_password variable must be 8 to 72 characters (at most 72 bytes), contain a letter and a number, and have no tabs, line breaks or leading or trailing spaces."
  }
}
