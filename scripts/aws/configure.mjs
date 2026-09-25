// Run with: node --env-file=.env scripts/aws/configure.mjs
// Secrets are passed to AWS/Kubernetes over stdin, never command arguments or logs.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const region = 'ap-southeast-2';
function aws(args, input) {
  return execFileSync('aws', [...args, '--region', region, '--output', 'json'], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
const identity = JSON.parse(aws(['sts', 'get-caller-identity']));
if (identity.Account !== '523227112806') throw new Error('Wrong AWS account');
const deployment = JSON.parse(execFileSync('python3', ['scripts/aws/terraform.py', '-chdir=infra/aws/foundation', 'output', '-json', 'deployment'], { encoding: 'utf8' }));
const database = JSON.parse(JSON.parse(aws(['secretsmanager', 'get-secret-value', '--secret-id', deployment.database_secret_arn])).SecretString);
let previous = {};
try { previous = JSON.parse(JSON.parse(aws(['secretsmanager', 'get-secret-value', '--secret-id', deployment.application_secret_arn])).SecretString); }
catch (error) { if (!String(error.stderr).includes('ResourceNotFoundException')) throw new Error('Could not read existing application configuration'); }
const values = {
  ...previous,
  DATABASE_URL: `postgres://${encodeURIComponent(database.username)}:${encodeURIComponent(database.password)}@${deployment.database_host}:5432/tabductor?sslmode=verify-full`,
  NODE_EXTRA_CA_CERTS: '/app/infra/aws/rds-ca.pem',
  TABDUCTOR_DEPLOYMENT_MODE: 'hosted', TABDUCTOR_FIXTURE_MODE: '0',
  AWS_REGION: region, BLOB_DRIVER: 's3', BLOB_BUCKET: deployment.blob_bucket,
  SECRETS_KMS_KEY_ARN: deployment.kms_key_arn,
  BROWSER_MODE: 'fleet', BROWSER_WEB_URL: 'http://staging-tabductor-web:3000',
  PYTHON_RUNNER_TOKEN: previous.PYTHON_RUNNER_TOKEN || randomBytes(48).toString('base64url'),
  BROWSER_WORKER_TOKEN_KEY: previous.BROWSER_WORKER_TOKEN_KEY || randomBytes(48).toString('base64url'),
  BROWSER_RATE_VERSION: 'staging-v1', BROWSER_USD_PER_MINUTE: process.env.BROWSER_USD_PER_MINUTE || previous.BROWSER_USD_PER_MINUTE || '0', BROWSER_MAX_SECONDS: '1800',
  PADDLE_ENVIRONMENT: 'sandbox',
};
for (const name of ['CLERK_SECRET_KEY','NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','MODEL_USD_RATES_JSON',
  'PADDLE_API_KEY','PADDLE_CLIENT_TOKEN','PADDLE_WEBHOOK_SECRET','PADDLE_USD_PACKS_JSON','PADDLE_CHECKOUT_URL',
  'CAPSOLVER_API_KEY','TWO_CAPTCHA_API_KEY','ANTI_CAPTCHA_API_KEY','SOLVER_USD_RATES_JSON','ADMIN_ACCOUNT_IDS','LEGACY_CREDIT_USD','ACTION_SUMMARY_MODEL','IPROYAL_API_TOKEN']) {
  if (process.env[name]) values[name] = process.env[name];
}
if (!values.CLERK_SECRET_KEY?.startsWith('sk_test_') || !values.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_')) throw new Error('AWS staging requires Clerk development keys');
if (values.PADDLE_API_KEY && !values.PADDLE_API_KEY.startsWith('pdl_sdbx_')) throw new Error('AWS staging requires a Paddle sandbox API key');
aws(['secretsmanager','put-secret-value','--secret-id',deployment.application_secret_arn,'--secret-string','file:///dev/stdin'], JSON.stringify(values));
const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'tabductor-application', namespace: 'tabductor-staging' }, type: 'Opaque', stringData: values };
execFileSync('kubectl', ['apply','--server-side','--field-manager=tabductor-config','-f','-'], { input: JSON.stringify(secret), stdio: ['pipe','pipe','pipe'] });
console.log('Staging configuration stored in Secrets Manager and synchronized to Kubernetes.');
