#!/usr/bin/env bash
#
# List entries in the Aloxberry DynamoDB tables.
#
# Default target is the users table (the persistent linked-account state).
# Use --auth-codes for the short-lived OAuth-code table.
#
# Secrets (skillSecret, refreshToken, prevRefreshToken) are not printed in
# the default view. Use --full for raw DynamoDB JSON.
#
# Usage:
#   ./aws/scripts/ddb-list.sh                # users table, safe view
#   ./aws/scripts/ddb-list.sh --auth-codes   # auth-codes table
#   ./aws/scripts/ddb-list.sh --stage dev    # use dev tables
#   ./aws/scripts/ddb-list.sh --full         # raw JSON (includes secrets)

set -euo pipefail

PROFILE='loxberry-alexa'
REGION='eu-west-1'
STAGE='prod'
TARGET='users'
FULL=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --auth-codes) TARGET='authcodes'; shift ;;
        --users)      TARGET='users';     shift ;;
        --stage)      STAGE="$2";   shift 2 ;;
        --profile)    PROFILE="$2"; shift 2 ;;
        --region)     REGION="$2";  shift 2 ;;
        --full)       FULL=1;       shift ;;
        -h|--help)
            sed -n '2,15p' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

case "$TARGET" in
    users)     TABLE="alexa-loxberry-users-${STAGE}" ;;
    authcodes) TABLE="alexa-loxberry-authcodes-${STAGE}" ;;
esac

AWS_OPTS=(--region "$REGION" --profile "$PROFILE")

echo "Table: $TABLE"
echo

if [[ "$FULL" -eq 1 ]]; then
    aws dynamodb scan --table-name "$TABLE" "${AWS_OPTS[@]}" --output json
    exit 0
fi

if [[ "$TARGET" == 'users' ]]; then
    # Safe view: no secrets. JMESPath multiselect-hash preserves column
    # ordering and gives the AWS CLI table renderer proper headers.
    aws dynamodb scan \
        --table-name "$TABLE" "${AWS_OPTS[@]}" \
        --query 'Items[*].{User:userId.S,Bridge:bridgeUserId.S,Name:friendlyName.S,Created:createdAt.S,Updated:updatedAt.S}' \
        --output table
else
    aws dynamodb scan \
        --table-name "$TABLE" "${AWS_OPTS[@]}" \
        --query 'Items[*].{Code:code.S,User:userId.S,TTL:ttl.N,Created:createdAt.S}' \
        --output table
fi

COUNT="$(aws dynamodb scan \
    --table-name "$TABLE" "${AWS_OPTS[@]}" \
    --select COUNT --query Count --output text)"

echo
echo "Rows: $COUNT"
echo "(secrets hidden; use --full for raw JSON)"
