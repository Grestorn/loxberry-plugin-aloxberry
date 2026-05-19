#!/usr/bin/perl
#
# Print the LoxBerry-configured numeric log level (0-7) for this plugin on
# stdout line 1, then exit 0. On an unreadable value: nothing on stdout, a
# diagnostic on stderr, exit 1.
#
# Why this exists (and why it is NOT log-session-create.pl):
#   log-session-create.pl calls LOGSTART, which writes a session header and
#   REGISTERS a new entry in the plugin's logsessions DB (so the web log
#   viewer lists it). That is correct exactly once per daemon start.
#   This script is polled every ~45s by the daemon (bin/src/loglevel-watcher
#   .js) to pick up live level changes WITHOUT a restart, so it must be
#   strictly side-effect free: it constructs the LoxBerry::Log object (which
#   is enough for ->loglevel to resolve the configured value) but never calls
#   LOGSTART, so no session is created, no header is written, and the log
#   viewer's session list is untouched.
#
#   VERIFIED: LoxBerry::Log->new() on its own does not create/register a
#   session — LOGSTART does. The reference plugin (loxberry-bmw-cardata)
#   relies on this: token-manager.pl constructs the Log object
#   unconditionally, and its routinely-run `status` command path
#   (show_status) never calls LOGSTART; line 108 there even guards
#   "LOGSTART ... unless $force_refresh; # Don't double-start". So a poll
#   that only new()s is genuinely side-effect free. The level value itself
#   is the SAME one the per-plugin "Aktueller Log-Level" widget shows —
#   single source of truth, no mapping.
#
# Exit codes:
#   0  level on stdout line 1
#   1  level could not be determined (daemon keeps its current level)
#
# Called by the daemon's loglevel poller and the /log-level endpoint's
# "re-read now" path. Not intended for direct use.

use strict;
use warnings;

use LoxBerry::System;
use LoxBerry::Log;

# Same construction as log-session-create.pl, deliberately WITHOUT LOGSTART.
my $log = LoxBerry::Log->new(
    name    => 'daemon',
    stderr  => 0,
    addtime => 0,
);

# Documented accessor first; blessed-hash field as the back-compat fallback
# (older LoxBerry::Log copies expose only $self->{loglevel}).
my $lvl = eval { $log->loglevel };
$lvl //= $log->{loglevel};

if (defined $lvl && $lvl =~ /^\d+$/ && $lvl >= 0 && $lvl <= 7) {
    print "$lvl\n";
    exit 0;
}

print STDERR "lox-loglevel: level unreadable (got "
           . (defined $lvl ? "'$lvl'" : '<undef>') . ")\n";
exit 1;
