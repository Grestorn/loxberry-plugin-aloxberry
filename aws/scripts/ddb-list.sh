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
# For the users table the safe view shows:
#   - one row per linked Alexa account, with the LWA link-status column
#     (OK | REVOKED) sourced from the `lwaRevoked` flag the Lambda sets
#     on `invalid_grant`, sorted revoked-first;
#   - a per-bridgeUserId summary grouping users by Loxone installation,
#     so an "N of M accounts on this bridge need re-link" pattern is
#     visible at a glance.
#
# Requires `jq` for the enriched users view. Without jq the script falls
# back to the original JMESPath-projected table (no Status column).
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
            sed -n '2,28p' "$0"
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

# Auth-codes view is unchanged — short-lived OAuth state, no link-status.
if [[ "$TARGET" == 'authcodes' ]]; then
    aws dynamodb scan \
        --table-name "$TABLE" "${AWS_OPTS[@]}" \
        --query 'Items[*].{Code:code.S,User:userId.S,TTL:ttl.N,Created:createdAt.S}' \
        --output table

    COUNT="$(aws dynamodb scan \
        --table-name "$TABLE" "${AWS_OPTS[@]}" \
        --select COUNT --query Count --output text)"
    echo
    echo "Rows: $COUNT"
    echo "(secrets hidden; use --full for raw JSON)"
    exit 0
fi

# ---- Users table -----------------------------------------------------------

# Without jq we cannot derive Status / RevokedAt cleanly. Fall back to the
# legacy projection so the script keeps working on bare hosts.
if ! command -v jq >/dev/null 2>&1; then
    echo "(jq not found - falling back to legacy view without Status column)"
    echo "(install jq to see the per-bridge summary and revoked-link state)"
    echo
    aws dynamodb scan \
        --table-name "$TABLE" "${AWS_OPTS[@]}" \
        --query 'Items[*].{User:userId.S,Bridge:bridgeUserId.S,Name:friendlyName.S,Created:createdAt.S,Updated:updatedAt.S}' \
        --output table
    COUNT="$(aws dynamodb scan \
        --table-name "$TABLE" "${AWS_OPTS[@]}" \
        --select COUNT --query Count --output text)"
    echo
    echo "Rows: $COUNT"
    echo "(secrets hidden; use --full for raw JSON)"
    exit 0
fi

JSON="$(aws dynamodb scan --table-name "$TABLE" "${AWS_OPTS[@]}" --output json)"

# Pretty-aligned table via `column -t`, falling back to plain tab output if
# column(1) is missing on this host.
print_table() {
    if command -v column >/dev/null 2>&1; then
        column -t -s $'\t'
    else
        cat
    fi
}

echo "USERS"
{
    printf 'USER\tBRIDGE\tNAME\tSTATUS\tCREATED\tGRANTED\tREVOKED_AT\n'
    echo "$JSON" | jq -r '
        .Items
        | map({
            user:      (.userId.S // ""),
            bridge:    (.bridgeUserId.S // ""),
            name:      (.friendlyName.S // ""),
            revoked:   (.lwaRevoked.BOOL == true),
            status:    (if .lwaRevoked.BOOL == true then "REVOKED" else "OK" end),
            created:   (.createdAt.S // ""),
            granted:   (.lwaGrantedAt.S // ""),
            revokedAt: (.lwaRevokedAt.S // "")
          })
        # Revoked-first, then by bridge, then by createdAt — so problems
        # bubble to the top and clustering by bridge stays visible.
        | sort_by([(if .revoked then 0 else 1 end), .bridge, .created])
        | .[]
        | [.user, .bridge, .name, .status, .created, .granted, .revokedAt]
        | @tsv'
} | print_table

echo
echo "BRIDGES"
{
    printf 'BRIDGE\tUSERS\tOK\tREVOKED\tSTATE\n'
    echo "$JSON" | jq -r '
        .Items
        | group_by(.bridgeUserId.S // "")
        | map({
            bridge:  (.[0].bridgeUserId.S // ""),
            total:   length,
            revoked: (map(select(.lwaRevoked.BOOL == true)) | length)
          })
        | map(. + {
            ok:    (.total - .revoked),
            state: (
              if   .revoked == 0       then "healthy"
              elif .revoked == .total  then "ALL ACCOUNTS NEED RE-LINK"
              else "\(.revoked) of \(.total) need re-link"
              end
            )
          })
        | sort_by(-.revoked, .bridge)
        | .[]
        | [.bridge, (.total|tostring), (.ok|tostring), (.revoked|tostring), .state]
        | @tsv'
} | print_table

# Top-line summary.
TOTAL_USERS="$(echo "$JSON" | jq '.Items | length')"
TOTAL_REVOKED="$(echo "$JSON" | jq '[.Items[] | select(.lwaRevoked.BOOL == true)] | length')"
TOTAL_OK=$(( TOTAL_USERS - TOTAL_REVOKED ))
TOTAL_BRIDGES="$(echo "$JSON" | jq '[.Items[].bridgeUserId.S] | unique | length')"

echo
echo "Users:   $TOTAL_USERS total, $TOTAL_OK OK, $TOTAL_REVOKED revoked"
echo "Bridges: $TOTAL_BRIDGES total"
echo "(secrets hidden; use --full for raw JSON)"
