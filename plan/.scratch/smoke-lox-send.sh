#!/bin/bash
# Test driver for lox-send.pl — run on the LoxBerry.
# Each test produces a 3-line block: header, captured output, captured exit code.

SCRIPT=/tmp/lox-send.pl

run() {
  local name="$1"; shift
  echo "---- $name ----"
  output=$("$@" 2>&1)
  rc=$?
  echo "$output"
  echo "(exit code: $rc)"
  echo
}

run "1. no argv"                   "$SCRIPT"
run "2. wrong argv count"          "$SCRIPT" 1 foo
run "3. nonexistent VI on ms 1"    "$SCRIPT" 1 __aloxberry_test_nonexistent__ on
run "4. nonexistent miniserver"    "$SCRIPT" 99 anything on
