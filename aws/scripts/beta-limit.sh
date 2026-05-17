#!/usr/bin/env bash
#
# Query — or change — the beta connection cap, and show how many distinct
# LoxBerry installations are currently linked.
#
# "Connections" here = DISTINCT bridgeUserId values in the users table (one
# physical LoxBerry install = one slot, no matter how many Alexa accounts it
# linked). This matches exactly what the oauth-handler enforces at link time.
#
# The live limit lives in the config table under key `betaMaxConnections`.
# If that item doesn't exist yet, the Lambda is still using its env-var
# default (BetaMaxConnectionsDefault, 100) and will seed the item on the next
# link attempt.
#
# Usage:
#   ./aws/scripts/beta-limit.sh               # query (limit + usage)
#   ./aws/scripts/beta-limit.sh --set 250     # raise the cap to 250
#   ./aws/scripts/beta-limit.sh --stage dev   # use dev tables

set -euo pipefail

PROFILE='loxberry-alexa'
REGION='eu-west-1'
STAGE='prod'
SET_VALUE=''

while [[ $# -gt 0 ]]; do
    case "$1" in
        --set)     SET_VALUE="$2"; shift 2 ;;
        --stage)   STAGE="$2";     shift 2 ;;
        --profile) PROFILE="$2";   shift 2 ;;
        --region)  REGION="$2";    shift 2 ;;
        -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

USERS_TABLE="alexa-loxberry-users-${STAGE}"
CONFIG_TABLE="alexa-loxberry-config-${STAGE}"
CONFIG_KEY='betaMaxConnections'
AWS_OPTS=(--region "$REGION" --profile "$PROFILE")

# ---- Set mode ---------------------------------------------------------------
if [[ -n "$SET_VALUE" ]]; then
    if ! [[ "$SET_VALUE" =~ ^[0-9]+$ ]]; then
        echo "Error: --set value must be a non-negative integer." >&2
        exit 2
    fi
    NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    aws dynamodb put-item \
        --table-name "$CONFIG_TABLE" "${AWS_OPTS[@]}" \
        --item "{\"configKey\":{\"S\":\"${CONFIG_KEY}\"},\"value\":{\"N\":\"${SET_VALUE}\"},\"updatedAt\":{\"S\":\"${NOW}\"},\"note\":{\"S\":\"Beta cap on distinct LoxBerry installations.\"}}" \
        >/dev/null
    echo "Beta cap set to ${SET_VALUE} in ${CONFIG_TABLE}."
    echo
fi

# ---- Query mode (always runs) -----------------------------------------------
LIMIT="$(aws dynamodb get-item \
    --table-name "$CONFIG_TABLE" "${AWS_OPTS[@]}" \
    --key "{\"configKey\":{\"S\":\"${CONFIG_KEY}\"}}" \
    --query 'Item.value.N' --output text)"

USED="$(aws dynamodb scan \
    --table-name "$USERS_TABLE" "${AWS_OPTS[@]}" \
    --projection-expression 'bridgeUserId' \
    --query 'Items[*].bridgeUserId.S' --output text \
    | tr '[:space:]' '\n' | sed '/^$/d' | sort -u | wc -l | tr -d ' ')"

echo "Stage:                 $STAGE"
if [[ -z "$LIMIT" || "$LIMIT" == "None" ]]; then
    echo "Configured limit:      (not set — Lambda uses its env default, 100)"
else
    echo "Configured limit:      $LIMIT"
fi
echo "Distinct installs:     $USED"
if [[ -n "$LIMIT" && "$LIMIT" != "None" ]]; then
    REMAINING=$(( LIMIT - USED ))
    (( REMAINING < 0 )) && REMAINING=0
    echo "Remaining slots:       $REMAINING"
fi
