#!/usr/bin/perl
#
# lox-control.pl — UUID-based command helper for Loxone controls.
#
# Sister to lox-send.pl which targets Virtual Inputs by *name*. This helper
# targets any Loxone control by its uuidAction, via the standard Loxone
# webservice URL: `jdev/sps/io/<uuid>/<command>`.
#
# Use cases:
#   - PowerController TurnOn/TurnOff against a Switch / Light
#   - SceneController Activate against a Pushbutton
#   - any other capability we wire up that maps to `On` / `Off` / `Pulse`
#     / numeric setpoints against a single uuidAction
#
# Why this doesn't use LoxBerry::IO::mshttp_call (like lox-send.pl uses
# mshttp_send for VI-by-name): mshttp_call routes through the token-auth
# path which silently returns undef on some firmware/config combinations,
# even when basic auth on the same Miniserver works fine. We bypass it
# and do direct LWP with basic auth — same workaround we use in
# lox-getstructure.pl. Trade-off: each command re-pays basic-auth round-trip
# (no token cache); fine at Alexa traffic rates, and we get real HTTP
# status codes on failure instead of undef.
#
# Argv contract:
#   $1  miniserver_no   numeric (matches get_miniservers())
#   $2  uuid            control's uuidAction from LoxAPP3.json
#   $3  command         the verb the Miniserver expects (On, Off, Pulse, 0..100, ...)
#
# Output:
#   stdout: "ok" or "ok value=<echo>" on success; "fail: <reason>" on failure
#   exit 0 on success, 1 on Miniserver failure, 2 on usage error
#
# The `value=<echo>` suffix (when present) is the Miniserver's echo of what
# it actually applied. For ColorPickerV2 this is e.g. "hsv(120,80,50)" — a
# disagreement between requested and echoed value is a strong "silent no-op"
# signal that doesn't otherwise surface anywhere.

use strict;
use warnings;

if (@ARGV != 3) {
    print STDERR "usage: lox-control.pl <miniserver_no> <uuid> <command>\n";
    exit 2;
}

my ($msnr, $uuid, $cmd) = @ARGV;

# Defense-in-depth path-segment validation for jdev/sps/io/<uuid>/<cmd>.
# NOTE: HTTP::Request->new(GET => $url) does NOT re-encode an already-built
# URL string (the old comment claiming "LWP escapes for us anyway" was
# wrong), so anything that reaches $url goes to the Miniserver verbatim.
# The caller (directive-router) is the primary guard (numeric/allowlisted
# modes); this is the backstop so a future caller can't path-traverse or
# inject a query/fragment into the authenticated request.
#
#   $uuid : a Loxone uuidAction. Two shapes:
#           - top-level control: strictly hex + dashes
#             (e.g. 1bd9a3ed-00b1-3956-ffff3b8739cfc0c6)
#           - sub-control of a LightControllerV2 / composite block: the
#             parent's hex+dash uuid followed by one or more
#             "/<alnum-segment>" suffixes (e.g. <parentUuid>/AI2,
#             <parentUuid>/masterValue). The slash is part of the
#             resource identifier Loxone expects on the jdev/sps/io
#             path — NOT a command separator. Rejecting it here was the
#             root cause of every "Lichtgruppe" failing while the parent
#             Lichtbaustein worked. Segments are strictly [A-Za-z0-9]+,
#             so `..`, query/fragment, and backslash can't slip through.
#   $cmd  : a structured command. Legitimate shapes include On / off /
#           reset / 42 / 21.5 / changeTo/5 / setTimer/7200/100/2/0 /
#           repeat/1 / source/3 / setFan/1 / hsv(120,100,50) /
#           temp(50,4000). Allow exactly that character set; reject `..`
#           path segments and the URL-structural chars ? # % \ and
#           whitespace/control chars.
if (!defined $uuid || $uuid !~ m{\A[0-9A-Fa-f-]+(?:/[A-Za-z0-9]+)*\z}) {
    print STDERR "fail: invalid uuid (expected hex+dashes, optionally with /<alnum> sub-control suffixes)\n";
    exit 2;
}
if (!defined $cmd
    || $cmd !~ m{\A[A-Za-z0-9_.()/,:+-]+\z}
    || $cmd =~ m{(?:\A|/)\.\.(?:/|\z)}) {
    print STDERR "fail: command contains illegal characters or a path-traversal segment\n";
    exit 2;
}

require LWP::UserAgent;
require HTTP::Request;
require LoxBerry::System;

my %ms = LoxBerry::System::get_miniservers();
my $m  = $ms{$msnr};
unless (defined $m) {
    print "fail: miniserver $msnr is not configured in LoxBerry\n";
    exit 1;
}

my $host = $m->{IPAddress} // '';
my $use_https = $m->{PreferHttps} ? 1 : 0;
my $port = (($use_https ? $m->{PortHttps} : $m->{Port}) // ($use_https ? 443 : 80)) + 0;
my $user = $m->{Admin}    // '';
# CRITICAL: Pass_RAW is the decoded password; Pass is URL-encoded.
my $pass = $m->{Pass_RAW} // $m->{Pass} // '';

unless ($host && $user && $pass) {
    print "fail: miniserver $msnr is missing host or credentials in LoxBerry config\n";
    exit 1;
}

my $scheme = $use_https ? 'https' : 'http';
my $url    = "$scheme://$host:$port/jdev/sps/io/$uuid/$cmd";

my $ua = LWP::UserAgent->new(
    timeout => 5,
    # Loxone Miniservers typically use self-signed certs when running over
    # HTTPS in the LAN; verify_hostname=0 keeps that workable.
    ssl_opts => { verify_hostname => 0, SSL_verify_mode => 0 },
);

my $req = HTTP::Request->new(GET => $url);
$req->authorization_basic($user, $pass);

my $resp = $ua->request($req);
if (!$resp->is_success) {
    my $code = $resp->code;
    if ($code == 401) {
        print "fail: HTTP 401 Unauthorized — check Admin / Pass_RAW in LoxBerry's Miniserver config\n";
    } elsif ($code == 404) {
        print "fail: HTTP 404 Not Found — UUID '$uuid' unknown to Miniserver, or wrong endpoint\n";
    } elsif ($code == 500 && $resp->message =~ /Can't connect/) {
        print "fail: cannot connect to $host:$port — Miniserver offline or wrong host/port\n";
    } else {
        print "fail: HTTP " . $resp->status_line . "\n";
    }
    exit 1;
}

my $body = $resp->decoded_content;

# Loxone command webservice returns {"LL":{"control":"...","value":"...","Code":"200"}}.
# Anything other than Code=200 means the command did not take effect.
#
# We surface the `value` field on success too. It's the Miniserver's echo of
# what it actually applied (e.g. "hsv(240,100,100)" for ColorPickerV2, or the
# numeric setpoint for a dimmer). When that value disagrees with what we asked
# for, the daemon's "succeeded" log will at least show the disagreement —
# previously we discarded this field and a silent no-op looked identical to a
# successful write.
if ($body =~ /"Code"\s*:\s*"?(\d+)"?/) {
    my $ll_code = $1;
    if ($ll_code == 200) {
        my $value = '';
        if ($body =~ /"value"\s*:\s*"((?:[^"\\]|\\.)*)"/) {
            $value = $1;
        }
        if (length $value) {
            print "ok value=$value\n";
        } else {
            print "ok\n";
        }
        exit 0;
    }
    print "fail: Miniserver returned LL.Code=$ll_code (URL=$url)\n";
    exit 1;
}

my $excerpt = substr($body, 0, 120);
$excerpt =~ s/\s+/ /g;
print "fail: unexpected response shape: $excerpt\n";
exit 1;
