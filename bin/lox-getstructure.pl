#!/usr/bin/perl
#
# lox-getstructure.pl — fetch LoxAPP3.json from a Miniserver.
#
# Invoked by the Node daemon at startup (and on user-triggered refresh).
#
# Why this doesn't use LoxBerry::IO::mshttp_call (like lox-send.pl uses
# mshttp_send): mshttp_call appears to handle non-LL-wrapped responses
# poorly. /data/LoxAPP3.json is plain JSON, not a /jdev/ LL envelope, and
# mshttp_call silently returns undef for it on at least some firmware/
# LoxBerry combinations. Direct LWP gives us the HTTP status code on
# failure, which is a much better diagnostic.
#
# Output:
#   stdout — the raw LoxAPP3.json content (typically 50–500 KB)
#   exit 0 on success
#   exit 1 on Miniserver-side failure (network, auth, 404, etc.)
#   exit 2 on usage / config error
#
# Usage:
#   lox-getstructure.pl <miniserver_no>

use strict;
use warnings;

if (@ARGV != 1) {
    print STDERR "usage: lox-getstructure.pl <miniserver_no>\n";
    exit 2;
}

my ($msnr) = @ARGV;

# Defer imports so usage errors stay cheap.
require LWP::UserAgent;
require HTTP::Request;
require LoxBerry::System;

# Pull the miniserver's connection details from LoxBerry's own config so we
# don't have to ask the user for creds again.
my %ms = LoxBerry::System::get_miniservers();
my $m = $ms{$msnr};
unless (defined $m) {
    print STDERR "fail: miniserver $msnr is not configured in LoxBerry\n";
    exit 2;
}

my $host = $m->{IPAddress} // '';
my $use_https = $m->{PreferHttps} ? 1 : 0;
my $port = (($use_https ? $m->{PortHttps} : $m->{Port}) // ($use_https ? 443 : 80)) + 0;
my $user = $m->{Admin}    // '';
# CRITICAL: Pass_RAW is the decoded password; Pass is URL-encoded. Same trap
# as bin/lox-getconfig.pl documents (see the comment there).
my $pass = $m->{Pass_RAW} // $m->{Pass} // '';

unless ($host) {
    print STDERR "fail: miniserver $msnr has no IPAddress in LoxBerry config\n";
    exit 2;
}
unless ($user && $pass) {
    print STDERR "fail: miniserver $msnr has no credentials in LoxBerry config\n";
    exit 2;
}

my $scheme = $use_https ? 'https' : 'http';
my $url = "$scheme://$host:$port/data/LoxAPP3.json";

my $ua = LWP::UserAgent->new(
    timeout => 30,
    # Loxone Miniservers typically use self-signed certs when running over
    # HTTPS in the LAN; verify_hostname=0 keeps that workable. Anything
    # public-facing should be fronted by a real reverse proxy anyway.
    ssl_opts => { verify_hostname => 0, SSL_verify_mode => 0 },
);

my $req = HTTP::Request->new(GET => $url);
$req->authorization_basic($user, $pass);

my $resp = $ua->request($req);
if (!$resp->is_success) {
    my $code = $resp->code;
    my $msg  = $resp->status_line // '?';
    if ($code == 401) {
        print STDERR "fail: HTTP 401 Unauthorized for $url — check Admin / Pass_RAW in LoxBerry's Miniserver config\n";
    } elsif ($code == 404) {
        print STDERR "fail: HTTP 404 Not Found for $url — Miniserver may be too old to expose LoxAPP3.json at this path\n";
    } elsif ($code == 500 && $resp->message =~ /Can't connect/) {
        print STDERR "fail: cannot connect to $host:$port — Miniserver offline or wrong host/port in LoxBerry config\n";
    } else {
        print STDERR "fail: HTTP $msg for $url\n";
    }
    exit 1;
}

my $body = $resp->decoded_content;
unless (defined $body && length $body) {
    print STDERR "fail: empty response body from $url\n";
    exit 1;
}

# Defensive sanity check — an HTML 401 page or similar would not start with `{`.
if ($body !~ /^\s*\{/) {
    my $snippet = substr($body, 0, 60);
    $snippet =~ s/\s+/ /g;
    print STDERR "fail: response does not look like JSON (starts with: $snippet...)\n";
    exit 1;
}

print $body;
exit 0;
