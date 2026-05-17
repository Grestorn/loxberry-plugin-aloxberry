#!/usr/bin/perl
#
# lox-getconfig.pl — emit Miniserver configuration as JSON.
#
# Wraps `LoxBerry::System::get_miniservers()` so the Node daemon never has
# to parse LoxBerry's INI/JSON config layout itself. One spawn at daemon
# startup, then everything stays in Node memory.
#
# Safety: credentials are NOT included by default. Pass --with-credentials
# to opt in. The daemon does that explicitly; ad-hoc dev probes don't, so
# stray runs can't leak passwords into shell history / log files.
#
# Output (default):
#   [
#     {
#       "msNo":        1,
#       "name":        "KSE1",
#       "host":        "miniserver-mse3c8.home",
#       "portHttp":    80,
#       "portHttps":   443,
#       "preferHttps": true,
#       "scheme":      "https",
#       "useCloudDNS": false,
#       "cloudUrl":    ""
#     }
#   ]
#
# With --with-credentials, each entry additionally has:
#   "username": "Martin", "password": "..."
#
# Exit codes:
#   0 → success, JSON on stdout
#   1 → LoxBerry returned no miniservers (UI hasn't been used)
#   2 → usage error

use strict;
use warnings;

use Getopt::Long;
use LoxBerry::System;
use JSON;

my $with_creds = 0;
GetOptions('with-credentials' => \$with_creds)
    or do {
        print STDERR "usage: lox-getconfig.pl [--with-credentials]\n";
        exit 2;
    };

if (@ARGV) {
    print STDERR "usage: lox-getconfig.pl [--with-credentials]\n";
    exit 2;
}

my %ms = LoxBerry::System::get_miniservers();
if (!%ms) {
    print STDERR "no miniservers configured on this LoxBerry\n";
    exit 1;
}

my @out;
for my $no (sort { $a <=> $b } keys %ms) {
    my $m = $ms{$no};

    my $entry = {
        msNo        => $no + 0,
        name        => $m->{Name}        // '',
        host        => $m->{IPAddress}   // '',
        portHttp    => ($m->{Port}      // 80)  + 0,
        portHttps   => ($m->{PortHttps} // 443) + 0,
        preferHttps => $m->{PreferHttps}    ? JSON::true : JSON::false,
        scheme      => $m->{Transport}   // 'http',
        useCloudDNS => $m->{UseCloudDNS}     ? JSON::true : JSON::false,
        cloudUrl    => $m->{CloudURL}    // '',
    };

    if ($with_creds) {
        $entry->{username} = $m->{Admin} // '';
        # CRITICAL: use Pass_RAW, not Pass.
        # LoxBerry stores the Miniserver password twice:
        #   Pass       — URL-encoded (for embedding in URLs like FullURI)
        #   Pass_RAW   — the actual decoded password (the bytes the Miniserver
        #                stored and will use to compute the expected HMAC)
        # The auth handshake (getkey2 + getjwt) hashes the RAW password, so
        # Pass_RAW is the right field. Using Pass produces a wrong pwHash and
        # the Miniserver returns 401 — every time. Days of debugging here.
        $entry->{password} = $m->{Pass_RAW} // $m->{Pass} // '';
    }

    push @out, $entry;
}

print JSON::to_json(\@out, { utf8 => 1, canonical => 1 });
print "\n";
exit 0;
