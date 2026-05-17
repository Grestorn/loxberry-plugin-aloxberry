#!/usr/bin/env bash
#
# Clear all entries from a Aloxberry DynamoDB table.
#
# Two safety layers:
#   - Default is dry-run: lists the keys that would be deleted; no writes.
#   - With --apply, the script prompts for a typed confirmation including
#     the row count + table name; only proceeds on an exact match. This is
#     deliberately impossible to satisfy with a simple "y/n" reflex.
#
# Scope: the users table is the persistent linked-account state — wiping
# it forces every Alexa user to re-link the skill. The auth-codes table
# is short-lived (10-min TTL) and clearing it has no user-visible effect.
#
# Usage:
#   ./aws/scripts/ddb-clear.sh                       # dry-run, users-prod
#   ./aws/scripts/ddb-clear.sh --apply               # actually delete (with prompt)
#   ./aws/scripts/ddb-clear.sh --auth-codes          # target auth-codes table
#   ./aws/scripts/ddb-clear.sh --stage dev --apply   # dev users table

set -euo pipefail

PROFILE='loxberry-alexa'
REGION='eu-west-1'
STAGE='prod'
TARGET='users'
APPLY=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --auth-codes) TARGET='authcodes'; shift ;;
        --users)      TARGET='users';     shift ;;
        --stage)      STAGE="$2";   shift 2 ;;
        --profile)    PROFILE="$2"; shift 2 ;;
        --region)     REGION="$2";  shift 2 ;;
        --apply)      APPLY=1;      shift ;;
        -h|--help)
            sed -n '2,21p' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

case "$TARGET" in
    users)     TABLE="alexa-loxberry-users-${STAGE}";     KEY_NAME='userId' ;;
    authcodes) TABLE="alexa-loxberry-authcodes-${STAGE}"; KEY_NAME='code'   ;;
esac

AWS_OPTS=(--region "$REGION" --profile "$PROFILE")

# Pull the key column only — even in a paginated scan this is cheap and
# avoids dragging secrets onto the local disk via shell history.
RAW="$(aws dynamodb scan \
    --table-name "$TABLE" "${AWS_OPTS[@]}" \
    --projection-expression "$KEY_NAME" \
    --query "Items[*].$KEY_NAME.S" \
    --output text)"

# --output text joins array elements with tabs (single line per page); read
# them into an array via word-splitting.
KEYS=()
if [[ -n "$RAW" ]]; then
    # shellcheck disable=SC2206  # intentional word-split
    KEYS=( $RAW )
fi
COUNT="${#KEYS[@]}"

echo "Table: $TABLE"
echo "Rows:  $COUNT"
echo

if [[ "$COUNT" -eq 0 ]]; then
    echo "Nothing to delete."
    exit 0
fi

echo "Keys that would be deleted:"
for k in "${KEYS[@]}"; do
    echo "  - $k"
done

if [[ "$APPLY" -ne 1 ]]; then
    echo
    echo "Dry-run (no deletions). Re-run with --apply to actually delete."
    exit 0
fi

EXPECTED="DELETE $COUNT FROM $TABLE"
echo
echo "About to delete $COUNT row(s) from $TABLE."
echo "Type exactly:  $EXPECTED"
read -r -p '> ' TYPED

if [[ "$TYPED" != "$EXPECTED" ]]; then
    echo "Confirmation did not match. Aborting."
    exit 1
fi

echo
echo "Deleting..."
i=0
for k in "${KEYS[@]}"; do
    i=$((i + 1))
    aws dynamodb delete-item \
        --table-name "$TABLE" "${AWS_OPTS[@]}" \
        --key "{\"$KEY_NAME\": {\"S\": \"$k\"}}" \
        >/dev/null
    echo "  [$i/$COUNT] deleted $k"
done

echo
echo "Done."
