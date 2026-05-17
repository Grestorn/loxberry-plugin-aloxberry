#!/usr/bin/perl
#
# Open a new LoxBerry log session for the daemon and print:
#   line 1: the absolute path of the freshly-created log file
#   line 2: the LoxBerry numeric log level for this plugin (0-7), or empty
#           if the value could not be determined (control.sh then falls
#           back to whatever LOG_LEVEL daemon.env happened to export — or,
#           if that's also empty, the daemon defaults to 'info').
#
# Why this exists:
#   The daemon is Node.js; LoxBerry::Log is Perl. We bridge the two by
#   having Perl create + register the session (so LoxBerry's log-viewer UI
#   lists it and the rotation/auto-cleanup logic sees it), then handing
#   the resulting file path back to bash. control.sh redirects the node
#   process's stdout/stderr to that file with `>> "$LOG_FILE"`.
#
#   The level is read from the SAME source the LoxBerry log-list widget
#   shows ("Aktueller Log-Level" in the per-plugin section). Single source
#   of truth: user changes the level in LoxBerry's UI → next daemon start
#   picks it up. No daemon.env round-trip, no mapping table — the daemon's
#   custom logger (bin/src/log.js) accepts LoxBerry's 0-7 numeric values
#   natively.
#
# Exit codes:
#   0  success — the path is on stdout line 1; the level is on stdout line 2
#                (empty if unreadable; non-fatal — daemon picks a default).
#   1  could not determine the session's file path (LoxBerry::Log changed?).
#
# Called by bin/control.sh's cmd_start. Not intended for direct use.

use strict;
use warnings;

use LoxBerry::System;
use LoxBerry::Log;

# A fresh session per daemon start. The "name" field becomes part of the
# generated filename, so the log-viewer UI can identify it as a daemon log
# vs. e.g. CGI logs from the web UI.
#
#   stderr  => 0   we redirect node's stderr separately in control.sh
#                  (combined with stdout into the same file)
#   addtime => 0   the daemon's custom logger emits its own ISO-8601
#                  timestamps already; doubling up via LoxBerry's prefix
#                  would just clutter every line
my $log = LoxBerry::Log->new(
    name    => 'daemon',
    stderr  => 0,
    addtime => 0,
);

# LOGSTART writes the session header line + registers this session in the
# plugin's logsessions DB. The web log-viewer reads that DB to build its
# session list.
LOGSTART('Aloxberry daemon');

# Defensive: try the documented accessor first, fall back to the blessed-hash
# field. LoxBerry::Log's public API exposes filename() in recent versions but
# older copies expose only $self->{filename}.
my $filename = eval { $log->filename };
$filename //= $log->{filename};

unless (defined $filename && length $filename) {
    print STDERR "log-session-create: could not determine log file path\n";
    exit 1;
}

# Read the LoxBerry-configured numeric level for this plugin. Same field
# the `loglist_html()` widget displays; no double-storage. Pass it through
# raw — the daemon's logger (bin/src/log.js) accepts integers 0-7 directly,
# so there's no mapping table to keep in sync.
#
# Wrapped in eval so a missing accessor doesn't kill the daemon start.
my $lb_level = eval { $log->loglevel };
$lb_level //= $log->{loglevel};

my $level_out = '';
if (defined $lb_level && $lb_level =~ /^\d+$/ && $lb_level >= 0 && $lb_level <= 7) {
    $level_out = $lb_level;
} else {
    print STDERR "log-session-create: LoxBerry level unreadable (got "
               . (defined $lb_level ? "'$lb_level'" : '<undef>')
               . "), daemon will fall back to default\n";
}

# Two-line contract: control.sh reads line 1 as the file path, line 2 as
# the level to export. An empty line 2 means "no override".
print "$filename\n";
print "$level_out\n";
exit 0;
