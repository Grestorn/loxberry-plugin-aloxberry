#!/usr/bin/env bash
#
# Tail CloudWatch logs for the Aloxberry Lambda functions.
#
# Both functions by default (alexa-handler + oauth-handler), interleaved
# with [alexa] / [oauth] line prefixes. Use --function to narrow to one.
# Ctrl-C exits both.
#
# Usage:
#   ./aws/scripts/tail-aws.sh                       # tail both, last 1m + live
#   ./aws/scripts/tail-aws.sh --function alexa      # alexa-handler only
#   ./aws/scripts/tail-aws.sh --function oauth      # oauth-handler only
#   ./aws/scripts/tail-aws.sh --since 10m           # show last 10 minutes first
#   ./aws/scripts/tail-aws.sh --filter "ERROR"      # CloudWatch filter pattern
#   ./aws/scripts/tail-aws.sh --no-follow --since 1h
#       # Dump the last hour's events and exit (no streaming). Use this
#       # for post-mortem diagnostics. Live-tail mode has unavoidable
#       # buffering latency (aws-cli's Python stdout is block-buffered
#       # when not connected to a TTY); --no-follow has none.
#
# Requires: aws cli v2 authenticated to the `loxberry-alexa` profile.

set -uo pipefail

PROFILE='loxberry-alexa'
REGION='eu-west-1'
STAGE='prod'
SINCE='1m'
FUNCTION='both'
FILTER=''
NO_FOLLOW=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        -f|--function) FUNCTION="$2"; shift 2 ;;
        --profile)     PROFILE="$2";  shift 2 ;;
        --region)      REGION="$2";   shift 2 ;;
        --stage)       STAGE="$2";    shift 2 ;;
        --since)       SINCE="$2";    shift 2 ;;
        --filter)      FILTER="$2";   shift 2 ;;
        --no-follow)   NO_FOLLOW=1;   shift   ;;
        -h|--help)
            sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

case "$FUNCTION" in
    alexa|oauth|both) ;;
    *) echo "--function must be alexa | oauth | both (got: $FUNCTION)" >&2; exit 2 ;;
esac

ALEXA_LG="/aws/lambda/loxberry-alexa-directive-$STAGE"
OAUTH_LG="/aws/lambda/loxberry-alexa-oauth-$STAGE"

# Clean up background tails on Ctrl-C or normal exit. Without this an
# orphaned `aws logs tail` would keep streaming after the script returns.
PIDS=()
cleanup() {
    if [[ ${#PIDS[@]} -gt 0 ]]; then
        kill "${PIDS[@]}" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

tail_one() {
    local lg="$1" tag="$2"
    local extra=()
    if [[ -n "$FILTER" ]]; then
        extra+=(--filter-pattern "$FILTER")
    fi
    # Stream stdout AND stderr (aws cli writes status to stderr) so the
    # operator sees auth errors instead of a silent script.
    #
    # `sed -u` forces line-buffered output — without it, sed block-buffers
    # to a 4 KB chunk when its stdout is a pipe (not a TTY), which makes
    # the script *appear* empty for minutes at a time even when aws-cli is
    # streaming events.
    #
    # When --no-follow is set, drop --follow so aws-cli exits after the
    # window and flushes its own buffer cleanly; gives you a one-shot
    # dump of the recent activity.
    local follow_args=(--follow)
    if [[ "$NO_FOLLOW" -eq 1 ]]; then
        follow_args=()
    fi
    aws logs tail "$lg" \
        "${follow_args[@]}" --since "$SINCE" \
        --profile "$PROFILE" --region "$REGION" \
        "${extra[@]}" 2>&1 \
        | sed -u "s|^|[$tag] |" &
    PIDS+=($!)
}

if [[ "$FUNCTION" == "alexa" || "$FUNCTION" == "both" ]]; then
    tail_one "$ALEXA_LG" "alexa"
fi
if [[ "$FUNCTION" == "oauth" || "$FUNCTION" == "both" ]]; then
    tail_one "$OAUTH_LG" "oauth"
fi

echo "Tailing Lambda logs (profile=$PROFILE region=$REGION stage=$STAGE since=$SINCE). Ctrl-C to stop."
echo ""

# wait blocks until both background tails exit (which they normally don't —
# the user Ctrl-Cs, EXIT trap kills them, wait returns).
wait
