#!/usr/bin/env bash
# Reproducible deploy with the plain aws CLI. Account 854924711083, us-east-1. Secrets are read from ../../.env and live only
# in the Lambda's encrypted environment. Re-running updates in place; nothing is deleted.
set -euo pipefail
cd "$(dirname "$0")"
REGION=us-east-1; ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCOUNT" = "854924711083" ] || { echo "wrong AWS account: $ACCOUNT"; exit 1; }
NAME=callcheck; TABLE=$NAME; ROLE=$NAME-lambda; FN=$NAME-api; BUCKET=$NAME-site-$ACCOUNT
STATE=.deploy-state; mkdir -p $STATE
set -a; . ../../.env; set +a
[ -f $STATE/admin-token ] || head -c 24 /dev/urandom | base64 | tr -d '/+=' > $STATE/admin-token
ADMIN_TOKEN=$(cat $STATE/admin-token)
MODEL=${BEDROCK_MODEL:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}

echo "== DynamoDB"
aws dynamodb describe-table --table-name $TABLE --region $REGION >/dev/null 2>&1 || {
  aws dynamodb create-table --table-name $TABLE --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST --region $REGION >/dev/null
  aws dynamodb wait table-exists --table-name $TABLE --region $REGION
  aws dynamodb update-time-to-live --table-name $TABLE --time-to-live-specification Enabled=true,AttributeName=ttl --region $REGION >/dev/null; }

echo "== IAM role"
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $ROLE --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  NEWROLE=1; fi
aws iam put-role-policy --role-name $ROLE --policy-name $NAME-access --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
 {\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:UpdateItem\"],\"Resource\":\"arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE\"},
 {\"Effect\":\"Allow\",\"Action\":[\"lambda:InvokeFunction\"],\"Resource\":\"arn:aws:lambda:$REGION:$ACCOUNT:function:$FN\"},
 {\"Effect\":\"Allow\",\"Action\":[\"bedrock:InvokeModel\"],\"Resource\":[\"arn:aws:bedrock:$REGION:$ACCOUNT:inference-profile/$MODEL\",\"arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0\"]}]}"
[ -z "${NEWROLE:-}" ] || sleep 12
ROLE_ARN=arn:aws:iam::$ACCOUNT:role/$ROLE

echo "== Package (SDK dist/esm only, production dependencies only)"
STAGE=$STATE/stage; mkdir -p $STAGE
rsync -a --delete backend/src backend/snapshots backend/package.json $STAGE/
(cd $STAGE && npm install --omit=dev --silent)
rm -f $STATE/lambda.zip
(cd $STAGE && zip -q -r ../lambda.zip package.json src snapshots node_modules -x 'node_modules/@paypal/paypal-server-sdk/dist/cjs/*' 'node_modules/@paypal/paypal-server-sdk/src/*' 'node_modules/.package-lock.json')
ls -la $STATE/lambda.zip | awk '{print "   zip bytes:", $5}'

envjson() { python3 - <<PY
import json,os
print(json.dumps({"Variables":{"PAYPAL_CLIENT_ID":os.environ["PAYPAL_CLIENT_ID"],"PAYPAL_SECRET":os.environ["PAYPAL_SECRET"],"PAYPAL_API":os.environ["PAYPAL_API"],"TABLE_NAME":"$TABLE","ADMIN_TOKEN":"$ADMIN_TOKEN","BEDROCK_MODEL":"$MODEL","SENDER_EMAIL":"sb-mixsn53098231@business.example.com","REGISTERED_RECIPIENTS":"sb-patient@personal.example.com","PAYPAL_WEBHOOK_ID":open("$STATE/webhook-id").read().strip() if os.path.exists("$STATE/webhook-id") else ""}}))
PY
}
echo "== Lambda"
if aws lambda get-function --function-name $FN --region $REGION >/dev/null 2>&1; then
  aws lambda update-function-code --function-name $FN --zip-file fileb://$STATE/lambda.zip --region $REGION >/dev/null
  aws lambda wait function-updated --function-name $FN --region $REGION
  aws lambda update-function-configuration --function-name $FN --environment "$(envjson)" --timeout 300 --memory-size 1024 --region $REGION >/dev/null
else
  aws lambda create-function --function-name $FN --runtime nodejs22.x --handler src/handler.handler --role $ROLE_ARN --zip-file fileb://$STATE/lambda.zip --timeout 300 --memory-size 1024 --environment "$(envjson)" --region $REGION >/dev/null
fi
aws lambda wait function-updated --function-name $FN --region $REGION
if aws lambda get-function-url-config --function-name $FN --region $REGION >/dev/null 2>&1; then
  aws lambda update-function-url-config --function-name $FN --region $REGION --invoke-mode RESPONSE_STREAM >/dev/null
else
  aws lambda create-function-url-config --function-name $FN --auth-type NONE --invoke-mode RESPONSE_STREAM --region $REGION >/dev/null
  aws lambda add-permission --function-name $FN --statement-id url-public --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE --region $REGION >/dev/null 2>&1 || true
fi
(cd backend && node add-url-permission.mjs $FN >/dev/null)
FN_URL=$(aws lambda get-function-url-config --function-name $FN --region $REGION --query FunctionUrl --output text); FN_URL=${FN_URL%/}
FN_HOST=${FN_URL#https://}

echo "== Front end build"
(cd frontend && npm install --silent && npx vite build >/dev/null)

echo "== S3 + CloudFront"
aws s3api head-bucket --bucket $BUCKET >/dev/null 2>&1 || {
  aws s3api create-bucket --bucket $BUCKET --region $REGION >/dev/null
  aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true; }
aws s3 sync frontend/dist s3://$BUCKET --delete --cache-control 'public,max-age=31536000,immutable' --exclude index.html --exclude favicon.svg --only-show-errors
aws s3 cp frontend/dist/index.html s3://$BUCKET/index.html --cache-control 'no-cache' --content-type 'text/html; charset=utf-8' --only-show-errors
aws s3 cp frontend/dist/favicon.svg s3://$BUCKET/favicon.svg --cache-control 'public,max-age=86400' --content-type 'image/svg+xml' --only-show-errors
if [ ! -f $STATE/cf-id ]; then
  OAC=$(aws cloudfront create-origin-access-control --origin-access-control-config "Name=$NAME-oac,Description=$NAME,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" --query OriginAccessControl.Id --output text)
  cat > $STATE/cf.json <<JSON
{"CallerReference":"$NAME-$(date +%s)","Comment":"$NAME","Enabled":true,"DefaultRootObject":"index.html","PriceClass":"PriceClass_100","HttpVersion":"http2and3",
 "Origins":{"Quantity":2,"Items":[
  {"Id":"s3","DomainName":"$BUCKET.s3.$REGION.amazonaws.com","OriginAccessControlId":"$OAC","S3OriginConfig":{"OriginAccessIdentity":""}},
  {"Id":"api","DomainName":"$FN_HOST","CustomOriginConfig":{"HTTPPort":80,"HTTPSPort":443,"OriginProtocolPolicy":"https-only","OriginSslProtocols":{"Quantity":1,"Items":["TLSv1.2"]},"OriginReadTimeout":60,"OriginKeepaliveTimeout":5}}]},
 "DefaultCacheBehavior":{"TargetOriginId":"s3","ViewerProtocolPolicy":"redirect-to-https","CachePolicyId":"658327ea-f89d-4fab-a63d-7e88639e58f6","Compress":true,"AllowedMethods":{"Quantity":2,"Items":["GET","HEAD"]}},
 "CacheBehaviors":{"Quantity":1,"Items":[{"PathPattern":"/api/*","TargetOriginId":"api","ViewerProtocolPolicy":"https-only","CachePolicyId":"4135ea2d-6df8-44a3-9df3-4b5a84be39ad","OriginRequestPolicyId":"b689b0a8-53d0-40ab-baf2-68738e2966ac","Compress":true,"AllowedMethods":{"Quantity":7,"Items":["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],"CachedMethods":{"Quantity":2,"Items":["GET","HEAD"]}}}]}}
JSON
  CF=$(aws cloudfront create-distribution --distribution-config file://$STATE/cf.json --query 'Distribution.[Id,DomainName,ARN]' --output text)
  echo "$CF" | awk '{print $1}' > $STATE/cf-id; echo "$CF" | awk '{print $2}' > $STATE/cf-domain; echo "$CF" | awk '{print $3}' > $STATE/cf-arn
  aws s3api put-bucket-policy --bucket $BUCKET --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"cf\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"cloudfront.amazonaws.com\"},\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\",\"Condition\":{\"StringEquals\":{\"AWS:SourceArn\":\"$(cat $STATE/cf-arn)\"}}}]}"
else aws cloudfront create-invalidation --distribution-id $(cat $STATE/cf-id) --paths '/*' >/dev/null; fi
CF_DOMAIN=$(cat $STATE/cf-domain)

echo "== PayPal webhook (reuse if it already points here; never delete anyone else's)"
TOK=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_SECRET" -d grant_type=client_credentials $PAYPAL_API/v1/oauth2/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
LIST=$(curl -s $PAYPAL_API/v1/notifications/webhooks -H "Authorization: Bearer $TOK")
COUNT=$(echo "$LIST" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("webhooks",[])))')
EXIST=$(echo "$LIST" | python3 -c "import sys,json;print(next((w['id'] for w in json.load(sys.stdin).get('webhooks',[]) if w['url']=='$FN_URL/api/webhooks/paypal'),''))")
echo "   $COUNT of 10 webhook slots used"
if [ -n "$EXIST" ]; then echo "$EXIST" > $STATE/webhook-id; echo "   reusing $EXIST"
elif [ "$COUNT" -ge 10 ]; then echo "   no free slot; leaving webhook unregistered (list them with GET /v1/notifications/webhooks)"
else
  WH=$(curl -s -X POST $PAYPAL_API/v1/notifications/webhooks -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"url\":\"$FN_URL/api/webhooks/paypal\",\"event_types\":[{\"name\":\"PAYMENT.PAYOUTS-ITEM.SUCCEEDED\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.FAILED\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.UNCLAIMED\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.BLOCKED\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.CANCELED\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.HELD\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.REFUNDED\"},{\"name\":\"PAYMENT.PAYOUTS-ITEM.RETURNED\"},{\"name\":\"PAYMENT.PAYOUTSBATCH.SUCCESS\"},{\"name\":\"PAYMENT.PAYOUTSBATCH.DENIED\"},{\"name\":\"INVOICING.INVOICE.CREATED\"},{\"name\":\"INVOICING.INVOICE.CANCELLED\"}]}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("id") or ("ERR "+json.dumps(d)[:200]))')
  case "$WH" in ERR*) echo "   webhook registration failed: $WH";; *) echo "$WH" > $STATE/webhook-id; echo "   registered $WH";; esac
fi
aws lambda update-function-configuration --function-name $FN --environment "$(envjson)" --region $REGION >/dev/null
aws lambda wait function-updated --function-name $FN --region $REGION

cat > deploy-output.json <<JSON
{"functionUrl":"$FN_URL","cloudFrontUrl":"https://$CF_DOMAIN","bucket":"$BUCKET","table":"$TABLE","webhookId":"$(cat $STATE/webhook-id 2>/dev/null)","region":"$REGION"}
JSON
cat deploy-output.json; echo "Deployed. CloudFront can take a few minutes to finish propagating."
