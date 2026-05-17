#!/usr/bin/perl
#
# lox-send.pl — one-shot Miniserver write helper.
#
# Invoked by the Node daemon as a spawned process. Each call:
#   1. Imports LoxBerry::IO (the community-maintained Miniserver client).
#   2. Calls mshttp_send($msnr, $name => $value), which under the hood does
#      a URI-escaped GET to /dev/sps/io/{name}/{value} on the chosen
#      Miniserver, using LoxBerry's cached HTTP credentials / token state.
#   3. Prints exactly one line:  "ok"  or  "fail: <reason>"
#   4. Exits 0 on success, 1 on Miniserver-side failure, 2 on usage error.
#
# Why one-shot and not a long-running daemon:
#   - LoxBerry::IO caches the Miniserver session on disk, so process startup
#     reuses the cached token. The startup tax is ~10-30 ms per call.
#   - Alexa traffic is a handful of commands per minute at peak; the cost is
#     invisible.
#   - Migration path (long-running Perl service over local HTTP) is documented
#     in plan/plugin-plan.md, kept in scope for the future.
#
# Argv contract — the Node side hard-codes this:
#   $1  miniserver_no   string-keyed numeric (1, 2, ...) — matches get_miniservers()
#   $2  name            virtual-input name as configured in Loxone Config
#   $3  value           literal value to write (on/off/0..100/text)
#
# Both name and value are passed through to LoxBerry::IO verbatim; it does
# the URI-escaping internally.

use strict;
use warnings;

# Bail early if argv is wrong — lets the Node-side spawn wrapper distinguish
# its own programming error (exit 2) from a real Miniserver failure (exit 1).
if (@ARGV != 3) {
    print STDERR "usage: lox-send.pl <miniserver_no> <name> <value>\n";
    exit 2;
}

my ($msnr, $name, $value) = @ARGV;

# Defer the require so usage errors don't pay the import cost.
require LoxBerry::IO;

# mshttp_send returns:
#   - in single-pair form: 1 on success, undef on failure
#   - in multi-pair form:  a hash of { name => 1|undef }, which we don't use
my $ok = LoxBerry::IO::mshttp_send($msnr, $name, $value);

if ($ok) {
    print "ok\n";
    exit 0;
}

# We can't get a richer reason out of mshttp_send — it folds all non-200
# responses to undef. If we ever need precise errors (timeout vs 404 vs auth),
# we'll switch to mshttp_call2 which returns ($value, $code, $resp) and
# accepts a configurable timeout.
print "fail: mshttp_send returned undef (Miniserver unreachable, value rejected, or VI not found)\n";
exit 1;
