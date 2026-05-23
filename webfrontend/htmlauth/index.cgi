#!/usr/bin/perl
#
# Aloxberry — Alexa Smart Home plugin for Loxone: config UI.
#
# Three-page CGI:
#   ?page=status   — "Setup" tab: connection state, daemon control, pair
#                    codes, settings (bridge URL + local port).
#   ?page=devices  — Loxone-control picker (catalogue from daemon /catalogue,
#                    user selection persisted to $LBPCONFIG/devices.json).
#   ?page=logs     — log-level config + LoxBerry log-session list.
#
# (The Setup tab kept its internal slug `status` for URL stability; the
# user-facing label is "Setup".)
#
# Default page: "devices" if at least one Alexa pairing has been observed,
# otherwise "status" — so a fresh install lands on the setup page, but once
# the user has paired Alexa they jump straight to the picker.
#
# Action routing (POST, on either page):
#   start | stop | restart       → control.sh ACTION
#   pair                         → daemon POST /pair (status page)
#   kill_pairings                → daemon POST /reset-pairings
#   save_settings                → write daemon.env  (status page)
#   save_devices                 → write devices.json (devices page)
#
# Authentication is handled by LoxBerry's htmlauth layer; only logged-in
# admins can reach this CGI.

use strict;
use warnings;

use CGI;
use HTML::Template;
use JSON::PP;
use HTTP::Tiny;
use POSIX qw(strftime);
use LoxBerry::System;
use LoxBerry::Web;
use LoxBerry::Log;

# ---- bootstrap ------------------------------------------------------------

my $cgi = CGI->new;

# Plugin metadata + the LoxBerry-provided runtime path globals
# ($lbpbindir, $lbpdatadir, $lbpconfigdir, $lbptemplatedir, $lbpplugindir).
my $plugin = LoxBerry::System::plugindata();
my $title  = "$plugin->{PLUGINDB_TITLE} $plugin->{PLUGINDB_VERSION}";

# "Ausführliche Hilfe" target (2nd arg to lbheader). Opens the repo README,
# which is the entry point to the full user/dev documentation. The inline
# help panel content is templates/<lang>/help.html (3rd arg, see below).
my $HELP_LINK = 'https://github.com/Grestorn/loxberry-plugin-aloxberry/blob/main/README.md';

# Constants — paths and the daemon's loopback endpoint
my $CONTROL_SH       = "$lbpbindir/control.sh";
my $STATE_JSON       = "$lbpdatadir/state.json";
my $PAIRINGS_JSON    = "$lbpdatadir/pairings.json";
my $LOXAPP3_JSON     = "$lbpdatadir/loxapp3.json";   # daemon's structure cache
my $DEVICES_JSON     = "$lbpconfigdir/devices.json"; # picker output, persists across upgrades
my $DAEMON_PID_FILE  = "$lbpdatadir/daemon.pid";
my $IDENTITY_USERID  = "$lbpconfigdir/identity/userId";
my $DAEMON_ENV       = "$lbpconfigdir/daemon.env";
my $CSRF_FILE        = "$lbpconfigdir/.csrf-secret";  # 0600, install-scoped
my $DAEMON_BASE      = "http://127.0.0.1:" . (daemon_port() // 7800);

# Port range — enforced server-side so a malformed POST can't produce a
# daemon.env that breaks daemon start. (Log level lives in LoxBerry's
# per-plugin level config, read at start by bin/log-session-create.pl —
# no UI form on our side, so no validation needed here.)

# ---- determine $page + load the right template ----------------------------
# We need the template BEFORE readlanguage so it can fill in the dotted-key
# language parameters (STATUS.RUNNING etc).
#
# Default page = "devices" unconditionally. (We used to switch based on
# whether any pairings existed, but every form submit without `?page=` then
# flipped the user back to Devices unexpectedly. With a fixed default and
# the empty `action=` on the Status forms, every page stays on itself.)
my $action = $cgi->param('action') || '';

my $pairings_initial = read_pairings();
my $page = $cgi->param('page') || '';
$page = '' unless $page =~ /^(status|devices|logs)$/;
$page = 'devices' unless $page;

my %template_for = (
    devices => 'devices.html',
    status  => 'status.html',
    logs    => 'logs.html',
);
my $template_file = $template_for{$page} // 'status.html';
my $template = HTML::Template->new(
    filename          => "$lbptemplatedir/$template_file",
    global_vars       => 1,
    loop_context_vars => 1,
    die_on_bad_params => 0,
);

# readlanguage fills $template's params with dotted-key labels (STATUS.RUNNING
# etc.) AND returns the hash so the action handlers below can build flash
# messages that reference the same strings.
my %L = LoxBerry::Web::readlanguage($template, "language.ini");

# ---- action dispatch -----------------------------------------------------

my $flash      = '';        # one-line user feedback after an action
my $flash_kind = 'info';    # info | success | warn | error
my $pair_code     = '';     # filled by action=pair
my $pair_expires  = 0;

# CSRF gate. Every action below mutates state; require POST + a valid
# same-origin synchronizer token. On failure we blank $action so control
# falls through to a plain (read-only) render with an error flash —
# nothing on disk is touched. GET can never trigger a mutation now even
# if ?action=stop is crafted (CGI->param reads the query string too).
my $CSRF = csrf_token();
if ($action ne '') {
    my $method = $cgi->request_method() // '';
    my $sent   = $cgi->param('csrf') // '';
    if ($method ne 'POST' || !csrf_eq($sent, $CSRF) || !csrf_same_origin($cgi)) {
        $flash      = $L{'CSRF.REJECTED'}
            || 'Security check failed. Reload the page and try the action again.';
        $flash_kind = 'error';
        $action     = '';
    }
}

if ($action eq 'start' || $action eq 'stop' || $action eq 'restart') {
    my ($exit, $out) = run_control($action);
    if ($exit == 0) {
        $flash      = $L{'CONTROL.ACTION_OK'};
        $flash      =~ s/\{action\}/$action/;
        $flash_kind = 'success';
    } else {
        $flash      = ($L{'CONTROL.ACTION_FAILED'} || 'Action {action} failed: {out}');
        $flash      =~ s/\{action\}/$action/;
        $flash      =~ s/\{out\}/$out/;
        $flash_kind = 'error';
    }
}
elsif ($action eq 'pair') {
    my $res = daemon_post('/pair');
    if ($res->{ok}) {
        my $body = eval { decode_json($res->{body}) } || {};
        $pair_code    = $body->{code} || '';
        $pair_expires = $body->{expiresInSec} || 0;
        $flash      = $L{'PAIR.READY'};
        $flash_kind = 'success';
    } else {
        $flash      = ($L{'PAIR.FAILED'} || 'Could not generate pair code: {err}');
        $flash      =~ s/\{err\}/$res->{err}/;
        $flash_kind = 'error';
    }
}
elsif ($action eq 'kill_pairings') {
    my $res = daemon_post('/reset-pairings');
    if ($res->{ok}) {
        $flash      = $L{'DANGER.KILLED'};
        $flash_kind = 'warn';
    } else {
        $flash      = ($L{'DANGER.KILL_FAILED'} || 'Could not invalidate pairings: {err}');
        $flash      =~ s/\{err\}/$res->{err}/;
        $flash_kind = 'error';
    }
}
elsif ($action eq 'clean_revoked') {
    # Asks the daemon to ask Lambda to delete the broken (lwaRevoked=true)
    # DDB rows for this bridgeUserId. The daemon also strips the matching
    # entries from pairings.json on success. Healthy linked accounts are
    # untouched — no identity rotation, no re-link required for them.
    my $res = daemon_post('/clean-revoked');
    if ($res->{ok}) {
        my $deleted = $res->{ddbDeleted} // 0;
        $flash      = ($L{'PAIRINGS.CLEAN_REVOKED_OK'} || 'Removed {count} broken Alexa link(s).');
        $flash      =~ s/\{count\}/$deleted/g;
        $flash_kind = ($deleted > 0) ? 'success' : 'info';
    } else {
        $flash      = ($L{'PAIRINGS.CLEAN_REVOKED_FAILED'} || 'Could not remove broken links: {err}');
        $flash      =~ s/\{err\}/$res->{err}/;
        $flash_kind = 'error';
    }
}
elsif ($action eq 'save_settings') {
    my $url  = trim_str($cgi->param('bridge_url'));
    my $port = trim_str($cgi->param('local_http_port'));

    my @errors;
    push @errors, $L{'SETTINGS.ERR_URL'}  unless $url =~ m{^https?://\S+};
    push @errors, $L{'SETTINGS.ERR_PORT'} unless $port =~ /^\d+$/ && $port >= 1024 && $port <= 65535;

    if (@errors) {
        $flash      = join(' / ', @errors);
        $flash_kind = 'error';
    } else {
        my $err = write_daemon_env($url, $port);
        if ($err) {
            $flash      = ($L{'SETTINGS.SAVE_FAILED'} || 'Could not write daemon.env: {err}');
            $flash      =~ s/\{err\}/$err/;
            $flash_kind = 'error';
        } else {
            # Apply the new env right away. control.sh's `restart` handles
            # the stopped case as a clean start, so this works whether or
            # not the daemon was running before the save.
            my ($rexit, $rout) = run_control('restart');
            if ($rexit == 0) {
                $flash      = $L{'SETTINGS.SAVED'};
                $flash_kind = 'success';
            } else {
                # Settings ARE persisted — only the apply step failed.
                # warn (yellow), not error (red): nothing was lost.
                my $msg = ($L{'SETTINGS.SAVED_RESTART_FAILED'}
                           || 'Settings saved, but daemon restart failed: {out}');
                $msg    =~ s/\{out\}/$rout/;
                $flash      = $msg;
                $flash_kind = 'warn';
            }
        }
    }
}
elsif ($action eq 'save_devices') {
    my $payload_json = $cgi->param('devices_json') // '';
    if (!length $payload_json) {
        $flash      = $L{'DEVICES.SAVE_EMPTY'} || 'No devices data submitted.';
        $flash_kind = 'error';
    } else {
        my $parsed = eval { decode_json($payload_json) };
        if (!$parsed || ref($parsed->{devices}) ne 'ARRAY') {
            $flash      = $L{'DEVICES.SAVE_BAD_JSON'} || 'Submitted data is not valid JSON.';
            $flash_kind = 'error';
        } else {
            my $clean_devices = sanitize_devices($parsed->{devices});
            my $clean_globals = sanitize_globals_in($parsed->{globals});
            my $err = write_devices_config($clean_devices, $clean_globals);
            if ($err) {
                my $msg = $L{'DEVICES.SAVE_FAILED'} || 'Could not write devices.json: {err}';
                $msg    =~ s/\{err\}/$err/;
                $flash      = $msg;
                $flash_kind = 'error';
            } else {
                my $count = scalar @$clean_devices;
                my $msg = $L{'DEVICES.SAVE_OK'} || 'Saved {count} device(s).';
                $msg    =~ s/\{count\}/$count/;
                $flash      = $msg;
                $flash_kind = 'success';
            }
        }
    }
}
elsif ($action) {
    $flash      = "Unknown action: $action";
    $flash_kind = 'warn';
}

# ---- read post-action state -----------------------------------------------
# The action above may have changed things on disk (kill_pairings wipes
# pairings.json, save_settings writes daemon.env, save_devices writes
# devices.json). Re-read everything *after* the action so the rendered page
# reflects the post-action world.

my $daemon   = read_daemon_status();
my $state    = read_state();
my $userid   = read_userid();
my $env      = read_daemon_env();
my $pairings = ($action =~ /^(kill_pairings|clean_revoked|pair)$/) ? read_pairings() : $pairings_initial;

# ---- navbar --------------------------------------------------------------
# LoxBerry::Web::lbheader reads `our %navbar` from this scope and renders it.

our %navbar;
# Devices is the default tab → put it on the left (lowest key = leftmost).
$navbar{10}{Name}   = $L{'NAV.DEVICES'} || 'Devices';
$navbar{10}{URL}    = 'index.cgi?page=devices';
$navbar{10}{active} = ($page eq 'devices') ? 1 : 0;
$navbar{20}{Name}   = $L{'NAV.SETUP'}   || 'Setup';
$navbar{20}{URL}    = 'index.cgi?page=status';
$navbar{20}{active} = ($page eq 'status') ? 1 : 0;
$navbar{30}{Name}   = $L{'NAV.LOGS'}    || 'Logs';
$navbar{30}{URL}    = 'index.cgi?page=logs';
$navbar{30}{active} = ($page eq 'logs') ? 1 : 0;

# ---- common params (both pages) -------------------------------------------
# (Language strings were already attached by readlanguage above.)

$template->param(
    # Page state
    PAGETITLE => $title,

    # CSRF synchronizer token — embedded as a hidden field in every POST
    # form; validated on every state-changing action above.
    CSRF_TOKEN => $CSRF,

    # Flash
    FLASH      => $flash,
    FLASH_KIND => $flash_kind,
    HAS_FLASH  => $flash ? 1 : 0,

    # Daemon
    DAEMON_RUNNING => $daemon->{running} ? 1 : 0,
    DAEMON_PID     => $daemon->{pid} || '',

    # Bridge
    BRIDGE_CONNECTED => $state->{bridge}{connected} ? 1 : 0,
    BRIDGE_ERROR     => $state->{bridge}{lastError} || '',
    BRIDGE_LAST_AT   => $state->{bridge}{lastConnectedAt} || '',

    # Miniserver
    MINISERVER_CONNECTED => $state->{miniserver}{connected} ? 1 : 0,
    MINISERVER_ERROR     => $state->{miniserver}{lastError} || '',
    MINISERVER_LAST_EVT  => $state->{miniserver}{lastEventAt} || '',
    EVENTS_SEEN          => $state->{miniserver}{eventsSeen} // 0,

    # Identity
    USER_ID => $userid,

    # Last directive
    LAST_DIRECTIVE_AT => $state->{lastDirectiveAt} || '',

    # Pair-code result (only populated when action=pair just ran)
    HAS_PAIR_CODE   => $pair_code ? 1 : 0,
    PAIR_CODE       => $pair_code,
    PAIR_EXPIRES_IN => $pair_expires,

    # Settings form values (from daemon.env). LOG_LEVEL deliberately not
    # exposed here — it's read from LoxBerry's per-plugin level on every
    # daemon start (see bin/log-session-create.pl).
    BRIDGE_URL      => $env->{BRIDGE_URL} // '',
    LOCAL_HTTP_PORT => $env->{LOCAL_HTTP_PORT} // '7800',

    # Active pairings (data/pairings.json — observed Alexa accounts that
    # have sent at least one directive). Empty list when nothing has run
    # yet; a fresh "kill all pairings" also wipes this back to empty.
    HAS_PAIRINGS => (@$pairings ? 1 : 0),
    PAIRINGS     => $pairings,
);

# ---- Link health banner ---------------------------------------------------
# Two distinct warning states the templates surface at the top of every page:
#
#   HEALTH_BRIDGE_DOWN   — the daemon's WSS connection to the bridge is down.
#                          Means status updates aren't reaching Alexa right
#                          now, regardless of any per-account state. While
#                          the bridge is down the revocation list is by
#                          definition stale (Lambda can't push fresh
#                          notifications and the daemon can't refetch the
#                          snapshot), so we hide HEALTH_REVOKED in that case
#                          to avoid alarmist UI for state we can't verify.
#
#   HEALTH_REVOKED       — one or more linked Alexa accounts had their LWA
#                          refresh-token revoked (Lambda flagged lwaRevoked
#                          on the user row). The user must re-link the skill
#                          in the Alexa app — there is no daemon-side
#                          recovery path.
#
# The daemon being entirely off / not running is treated as bridge-down (no
# connection = no traffic to Alexa); the banner copy directs to the Setup
# tab where daemon control + bridge status live.
my $bridge_down = (!$daemon->{running}) || (!$state->{bridge}{connected});
my $revoked_count = grep { $_->{REVOKED} } @$pairings;

# Resolve the singular/plural body once, with {count} substituted. The
# templates have no string-formatting of their own (HTML::Template is value
# substitution only), so we materialize the final sentence in Perl. Match
# the existing {err}/{count} pattern used elsewhere in this CGI.
my $revoked_body = '';
if ($revoked_count == 1) {
    $revoked_body = $L{'HEALTH.REVOKED_BODY_ONE'} || 'One Alexa account needs to be re-linked.';
} elsif ($revoked_count > 1) {
    $revoked_body = $L{'HEALTH.REVOKED_BODY_MANY'} || '{count} Alexa accounts need to be re-linked.';
    $revoked_body =~ s/\{count\}/$revoked_count/g;
}

$template->param(
    HEALTH_BRIDGE_DOWN   => $bridge_down                          ? 1 : 0,
    HEALTH_REVOKED       => (!$bridge_down && $revoked_count > 0) ? 1 : 0,
    HEALTH_REVOKED_COUNT => $revoked_count,
    HEALTH_REVOKED_BODY  => $revoked_body,
);

# ---- devices-page-specific params -----------------------------------------
# Inline the daemon's catalogue and the user's current devices.json so the
# picker's JS can render without making any AJAX requests on page load.

if ($page eq 'devices') {
    my ($catalogue, $cat_source, $cat_error) = fetch_catalogue($cgi);
    my ($devices, $globals) = read_devices_config_and_globals();
    $template->param(
        CATALOGUE_AVAILABLE   => $catalogue ? 1 : 0,
        CATALOGUE_SOURCE      => $cat_source,        # 'daemon' | 'disk' | ''
        CATALOGUE_ERROR       => $cat_error || '',
        CATALOGUE_FETCHED_AT  => $catalogue ? ($catalogue->{fetchedAt} || '') : '',
        CATALOGUE_STALE       => ($catalogue && $catalogue->{stale}) ? 1 : 0,
        CATALOGUE_CTRL_COUNT  => $catalogue ? scalar(@{$catalogue->{controls} || []}) : 0,
        CATALOGUE_JSON => json_for_html_script($catalogue || {}),
        DEVICES_JSON   => json_for_html_script({ version => 1, globals => $globals, devices => $devices }),
        DEVICES_COUNT  => scalar @$devices,
    );
}
elsif ($page eq 'logs') {
    # LoxBerry::Web::loglist_html() builds the standard log-session table for
    # the current plugin (sessions registered via LoxBerry::Log->new). The
    # bin/log-session-create.pl shim creates one session per daemon start;
    # those sessions appear here automatically, no further work needed.
    my $loglist = '';
    eval { $loglist = LoxBerry::Web::loglist_html(); };
    if ($@ || !defined $loglist) {
        $loglist = '<p class="ax-hint">'
                 . ($L{'LOGS.LIST_UNAVAILABLE'} || 'Log list unavailable.')
                 . '</p>';
    }
    $template->param(LOGLIST_HTML => $loglist);
}

# lbheader($pagetitle, $helpurl, $helptemplate). $helptemplate is resolved by
# LoxBerry as templates/<lang>/help.html (user language, English fallback) and
# rendered into the collapsible info panel; $helpurl is the "Ausführliche
# Hilfe" link at the top of that panel.
print LoxBerry::Web::lbheader($title, $HELP_LINK, 'help.html');
print $template->output;
print LoxBerry::Web::lbfooter();

exit 0;

# =============================================================================
# Helpers
# =============================================================================

# Read LOCAL_HTTP_PORT from daemon.env if present, fall back to 7800. The
# daemon binds 127.0.0.1:<port>; we have to talk to the same port it bound to.
sub daemon_port {
    my $env_file = "$lbpconfigdir/daemon.env";
    return 7800 unless -r $env_file;
    open(my $fh, '<', $env_file) or return 7800;
    while (my $line = <$fh>) {
        if ($line =~ /^\s*LOCAL_HTTP_PORT\s*=\s*['"]?(\d+)['"]?\s*$/) {
            close $fh;
            return $1;
        }
    }
    close $fh;
    return 7800;
}

# Shell out to control.sh start|stop|restart. Captures combined stdout+stderr.
# control.sh's stop/restart can take up to ~12 s (SIGTERM grace), so make
# sure the upstream web server's timeout is generous (LoxBerry's nginx
# defaults are fine).
sub run_control {
    my ($cmd) = @_;
    return (127, 'control.sh missing') unless -x $CONTROL_SH;
    my $out = `$CONTROL_SH \Q$cmd\E 2>&1`;
    my $exit = $? >> 8;
    chomp $out;
    return ($exit, $out);
}

# POST to the daemon's loopback HTTP API. Short timeout because the daemon
# is local — anything > 5 s here is the daemon being unhealthy, not a slow
# network.
sub daemon_post {
    my ($path) = @_;
    my $http = HTTP::Tiny->new(timeout => 10);
    my $resp = $http->post("$DAEMON_BASE$path");
    if (!$resp->{success}) {
        my $err = $resp->{reason} || 'unknown';
        if ($resp->{status} == 599) {
            $err = ($L{'DAEMON.NOT_LISTENING'} || 'daemon is not reachable on 127.0.0.1');
        }
        return { ok => 0, err => $err, status => $resp->{status} };
    }
    return { ok => 1, body => $resp->{content} };
}

# GET from the daemon's loopback HTTP API. Same semantics as daemon_post.
# Longer timeout because /catalogue?refresh=1 can take several seconds to
# fetch + parse a large LoxAPP3.json over slow Loxone networks.
sub daemon_get {
    my ($path, %opts) = @_;
    my $timeout = $opts{timeout} // 30;
    my $http = HTTP::Tiny->new(timeout => $timeout);
    my $resp = $http->get("$DAEMON_BASE$path");
    if (!$resp->{success}) {
        my $err = $resp->{reason} || 'unknown';
        if ($resp->{status} == 599) {
            $err = ($L{'DAEMON.NOT_LISTENING'} || 'daemon is not reachable on 127.0.0.1');
        }
        return { ok => 0, err => $err, status => $resp->{status} };
    }
    return { ok => 1, body => $resp->{content} };
}

# Fetch the catalogue for the picker. Strategy:
#   1. If ?refresh=1 in the URL → call /catalogue?refresh=1 on the daemon
#      (force a fresh LoxAPP3.json fetch from the Miniserver). Slow path.
#   2. Otherwise → call /catalogue (cached, fast).
#   3. If the daemon is unreachable → fall back to the on-disk cache that
#      the daemon persists at $LBPDATA/loxapp3.json, parse it like the
#      daemon does (just the bits the picker needs).
#
# ---- CSRF protection ------------------------------------------------------
# Synchronizer-token pattern. LoxBerry's htmlauth authenticates the admin
# but provides no per-form CSRF token, so every state-changing action here
# (daemon start/stop, repoint BRIDGE_URL, wipe pairings, overwrite
# devices.json) was forgeable by any page the logged-in admin visited.
# We mint a 256-bit install-scoped secret (0600, under the config dir that
# already holds identity/), embed it as a hidden field in every POST form,
# and require an exact constant-time match plus same-origin on every
# mutating request. The token is unreadable cross-origin (SOP), so a
# forged request cannot carry it.

sub csrf_token {
    if (open(my $fh, '<', $CSRF_FILE)) {
        local $/;
        my $t = <$fh>;
        close $fh;
        $t =~ s/\s+//g if defined $t;
        return $t if defined $t && $t =~ /^[0-9a-f]{64}$/;
    }
    my $tok;
    if (open(my $r, '<:raw', '/dev/urandom')) {
        my $buf = '';
        if (read($r, $buf, 32) == 32) { $tok = unpack('H*', $buf); }
        close $r;
    }
    # /dev/urandom is always present on LoxBerry; this fallback only keeps
    # the UI usable on an exotic host (still 256-ish bits of entropy).
    unless (defined $tok && $tok =~ /^[0-9a-f]{64}$/) {
        $tok = '';
        $tok .= sprintf('%04x', int(rand(65536))) for 1 .. 16;
    }
    my $tmp = "$CSRF_FILE.tmp.$$";
    if (open(my $w, '>', $tmp)) {
        chmod 0600, $tmp;
        print $w $tok;
        close $w;
        rename($tmp, $CSRF_FILE) or unlink $tmp;
    }
    return $tok;
}

# Length-checked constant-time string compare (no early-out on first
# differing byte).
sub csrf_eq {
    my ($a, $b) = @_;
    return 0 unless defined $a && defined $b;
    return 0 unless length($a) == length($b);
    my $diff = 0;
    $diff |= ord(substr($a, $_, 1)) ^ ord(substr($b, $_, 1))
        for 0 .. length($a) - 1;
    return $diff == 0 ? 1 : 0;
}

# Defense-in-depth: when the browser sends Origin/Referer, require it to
# match the request Host. Absent headers fall back to the token gate (some
# proxies strip Referer); a present-but-cross-origin header is rejected.
sub csrf_same_origin {
    my ($q) = @_;
    my $host = $q->http('Host') // $ENV{HTTP_HOST} // '';
    return 1 unless length $host;
    for my $hdr (qw(Origin Referer)) {
        my $v = $q->http($hdr);
        next unless defined $v && length $v;
        return ($v =~ m{^[a-z][a-z0-9+.-]*://\Q$host\E(?:[/:?#]|$)}i) ? 1 : 0;
    }
    return 1;
}

# Encode a Perl structure to JSON for embedding inside an inline
# <script type="application/json"> block. encode_json does NOT escape
# `<`, `>` or `&`, so a Loxone-controlled string (control/room/category
# name) containing `</script>` would terminate the block and inject
# attacker HTML/JS into the LoxBerry admin origin (stored XSS). We
# \uXXXX-escape exactly the characters that matter for the HTML/script
# parser; the result is still valid JSON (JSON.parse decodes the escapes
# back), so the picker JS is unaffected. encode_json returns UTF-8 BYTES
# (utf8 flag off), so the substitutions operate on bytes — including the
# 3-byte UTF-8 sequences for U+2028/U+2029, which are valid in JSON but
# break a JS string/HTML parsing in some engines.
sub json_for_html_script {
    my ($data) = @_;
    my $json = encode_json($data);
    $json =~ s/&/\\u0026/g;
    $json =~ s/</\\u003c/g;
    $json =~ s/>/\\u003e/g;
    $json =~ s/\xE2\x80\xA8/\\u2028/g;   # U+2028 LINE SEPARATOR
    $json =~ s/\xE2\x80\xA9/\\u2029/g;   # U+2029 PARAGRAPH SEPARATOR
    return $json;
}

# Returns ($catalogue_or_undef, $source_tag, $error_message_or_undef).
sub fetch_catalogue {
    my ($cgi) = @_;
    my $refresh = ($cgi->param('refresh') // '') eq '1';
    my $path = $refresh ? '/catalogue?refresh=1' : '/catalogue';
    my $resp = daemon_get($path, timeout => $refresh ? 35 : 5);
    if ($resp->{ok}) {
        my $body = eval { decode_json($resp->{body}) };
        if ($body && ref $body eq 'HASH') {
            return ($body, 'daemon', undef);
        }
    }
    # Fall back to on-disk cache. We do a minimal parse on the CGI side —
    # the daemon's parsed catalogue isn't persisted to disk, only the raw
    # LoxAPP3.json is. If the daemon has never successfully fetched, this
    # file won't exist either and the picker will render in empty-state.
    if (-r $LOXAPP3_JSON) {
        my $cat = parse_loxapp3_minimal($LOXAPP3_JSON);
        if ($cat) {
            $cat->{stale} = 1;
            $cat->{fetchedAt} ||= '(cached on disk)';
            return ($cat, 'disk', $resp->{err});
        }
    }
    return (undef, '', $resp->{err});
}

# Minimal parser for the on-disk LoxAPP3.json — only the bits the picker
# needs. Mirrors the shape that bin/src/structure.js produces, so the
# template's JS doesn't have to know which path the data came from.
sub parse_loxapp3_minimal {
    my ($path) = @_;
    # Raw byte read — decode_json handles UTF-8 internally; layering
    # :encoding(UTF-8) on top corrupts non-ASCII (control names, room
    # names) on the picker fallback path when the daemon is offline.
    open(my $fh, '<:raw', $path) or return undef;
    local $/;
    my $text = <$fh>;
    close $fh;
    my $raw = eval { decode_json($text) };
    return undef unless ref $raw eq 'HASH';

    # Loxone types we know how to expose — keep in sync with structure.js's TYPE_MAP.
    my %type_map = (
        Switch              => { category => 'SWITCH',         capabilities => ['PowerController'] },
        TimedSwitch         => { category => 'SWITCH',         capabilities => ['PowerController'] },
        Pushbutton          => { category => 'SCENE_TRIGGER',  capabilities => ['SceneController'] },
        Dimmer              => { category => 'LIGHT',          capabilities => ['PowerController', 'BrightnessController'] },
        LightControllerV2   => { category => 'LIGHT',          capabilities => ['PowerController', 'ModeController'] },
        ColorPickerV2       => { category => 'LIGHT',          capabilities => ['PowerController', 'BrightnessController', 'ColorController', 'ColorTemperatureController'] },
        Jalousie            => { category => 'INTERIOR_BLIND', capabilities => ['RangeController'] },
        IRoomControllerV2   => { category => 'THERMOSTAT',     capabilities => ['ThermostatController'] },
    );
    my %v1_implemented = map { $_ => 1 } qw(Switch TimedSwitch Pushbutton LightControllerV2 ColorPickerV2);

    my $rooms = $raw->{rooms} || {};
    my $cats  = $raw->{cats}  || {};
    my @rooms_list = map { { uuid => $_, name => ($rooms->{$_}{name} // '') } } keys %$rooms;
    my @cats_list  = map { { uuid => $_, name => ($cats->{$_}{name}  // '') } } keys %$cats;
    my @controls;

    my $push = sub {
        my ($uuid, $ctrl, $parent_uuid, $parent_name) = @_;
        my $type      = $ctrl->{type} // '';
        my $info      = $type_map{$type};
        my $room_uuid = $ctrl->{room} // ($parent_uuid && $raw->{controls}{$parent_uuid}{room}) // '';
        my $cat_uuid  = $ctrl->{cat}  // ($parent_uuid && $raw->{controls}{$parent_uuid}{cat})  // '';
        push @controls, {
            uuid           => $uuid,
            name           => $ctrl->{name} // '',
            type           => $type,
            roomUuid       => $room_uuid,
            roomName       => ($rooms->{$room_uuid}{name} // ''),
            catUuid        => $cat_uuid,
            catName        => ($cats->{$cat_uuid}{name} // ''),
            parentUuid     => $parent_uuid,
            parentName     => $parent_name,
            alexaCompatible => $info ? \1 : \0,
            v1Implemented   => $v1_implemented{$type} ? \1 : \0,
            defaults       => $info ? {
                displayCategory => $info->{category},
                capabilities    => $info->{capabilities},
            } : undef,
            uuidAction => $ctrl->{uuidAction} // $uuid,
        };
    };

    for my $uuid (keys %{$raw->{controls} || {}}) {
        my $ctrl = $raw->{controls}{$uuid};
        $push->($uuid, $ctrl, undef, undef);
        for my $sub_uuid (keys %{$ctrl->{subControls} || {}}) {
            $push->($sub_uuid, $ctrl->{subControls}{$sub_uuid}, $uuid, $ctrl->{name});
        }
    }

    return {
        rooms    => \@rooms_list,
        cats     => \@cats_list,
        controls => \@controls,
        msName   => ($raw->{msInfo}{msName} // $raw->{msInfo}{projectName} // ''),
    };
}

# ---- devices.json read + write -------------------------------------------

# Returns a 2-tuple: (\@devices, \%globals). Globals default to "all open"
# when the file doesn't exist or is malformed (so a fresh install isn't
# accidentally muted).
sub read_devices_config_and_globals {
    my $default_globals = {
        enabled => JSON::PP::true,
        vacationGate => { enabled => JSON::PP::false, controlUuid => undef },
    };
    return ([], $default_globals) unless -r $DEVICES_JSON;
    # decode_json expects UTF-8 BYTES. Open in :raw so PerlIO doesn't
    # pre-decode and turn the bytes into characters — decode_json would
    # otherwise re-encode characters back to bytes internally, yielding
    # mojibake on round-trip. See the parallel comment in write_devices_config.
    open(my $fh, '<:raw', $DEVICES_JSON) or return ([], $default_globals);
    local $/;
    my $text = <$fh>;
    close $fh;
    my $data = eval { decode_json($text) };
    return ([], $default_globals) unless ref $data eq 'HASH';
    my $devices = (ref $data->{devices} eq 'ARRAY') ? $data->{devices} : [];
    my $globals = sanitize_globals_in($data->{globals});
    return ($devices, $globals);
}

sub write_devices_config {
    my ($devices, $globals) = @_;
    my $tmp = "$DEVICES_JSON.tmp.$$";
    # encode_json returns a UTF-8 byte string (with the internal utf8 flag
    # OFF). We must write those bytes verbatim. The previous version used
    # `:encoding(UTF-8)` here, which made Perl treat each byte as a
    # codepoint and re-encode to UTF-8 — double-encoding every non-ASCII
    # character (e.g., "ä" → "Ã¤" on disk and downstream in Alexa).
    # `:raw` is explicit "no encoding/CRLF layer", matching what
    # encode_json hands us.
    my $payload = encode_json({
        version => 1,
        globals => $globals,
        devices => $devices,
    });

    open(my $fh, '>:raw', $tmp) or return "open $tmp: $!";
    print $fh $payload;
    close $fh or return "close: $!";
    chmod 0600, $tmp;
    rename($tmp, $DEVICES_JSON) or do { unlink $tmp; return "rename: $!" };
    return '';
}

# Defence-in-depth sanitizers — must mirror bin/src/devices-config.js's
# `_sanitizeDevices` exactly. Both run an allowlist over inbound JSON: this
# one filters the browser POST before write, the JS one filters on-disk
# devices.json before serving. New fields land in BOTH or the round-trip
# drops them silently (e.g., a "saved checkbox" that doesn't persist).
sub sanitize_devices {
    my ($raw) = @_;
    my %valid_cat = map { $_ => 1 } qw(
        LIGHT SWITCH OUTLET SMARTPLUG FAN
        THERMOSTAT AIR_CONDITIONER VENT
        TEMPERATURE_SENSOR HUMIDITY_SENSOR AIR_QUALITY_MONITOR
        CONTACT_SENSOR MOTION_SENSOR
        INTERIOR_BLIND EXTERIOR_BLIND GARAGE_DOOR DOOR
        SPEAKER STREAMING_DEVICE MUSIC_SYSTEM
        DOORBELL CAMERA
        SCENE_TRIGGER ACTIVITY_TRIGGER HUB
        OTHER
    );
    my $now = strftime('%Y-%m-%dT%H:%M:%SZ', gmtime);
    my @clean;
    for my $d (@$raw) {
        next unless ref $d eq 'HASH';
        next unless defined $d->{uuid} && length($d->{uuid}) >= 8;
        my $caps = (ref $d->{capabilities} eq 'ARRAY')
            ? [ grep { defined && length } @{$d->{capabilities}} ]
            : [];
        # JSON::PP::true and JSON::PP::false force the value to render as a
        # JSON boolean rather than the Perl numeric 1/0 (which encode_json
        # would otherwise emit). The daemon's JS reader checks ===true, so
        # passing a numeric 1 would actually break the flag round-trip too.
        # Clamp override-duration to the same 1..168h window the daemon enforces.
        my $override_hours = $d->{thermostatOverrideHours};
        $override_hours = (defined $override_hours && $override_hours =~ /^-?\d+$/)
            ? ($override_hours + 0) : 12;
        $override_hours = 1   if $override_hours < 1;
        $override_hours = 168 if $override_hours > 168;
        # Same shape for the Speaker AdjustVolume step (1..50, default 5).
        my $vol_step = $d->{audioVolumeStep};
        $vol_step = (defined $vol_step && $vol_step =~ /^-?\d+$/)
            ? ($vol_step + 0) : 5;
        $vol_step = 1  if $vol_step < 1;
        $vol_step = 50 if $vol_step > 50;
        # Ventilation manual-timer duration (1..168h, default 24h). Loxone
        # has no "set speed permanently" command — every Alexa write wraps
        # with setTimer/{N*3600}/.../-1, so this is the "manual override"
        # lifetime per device.
        my $vent_hours = $d->{ventilationOverrideHours};
        $vent_hours = (defined $vent_hours && $vent_hours =~ /^-?\d+$/)
            ? ($vent_hours + 0) : 24;
        $vent_hours = 1   if $vent_hours < 1;
        $vent_hours = 168 if $vent_hours > 168;
        # Binary-sensor ModeController custom labels. Trim + cap at 64
        # chars to match the daemon-side clampLabel; empty strings are
        # allowed and indicate "Discovery should use the generic fallback".
        my $label_active   = $d->{modeLabelActive};
        my $label_inactive = $d->{modeLabelInactive};
        $label_active   = (defined $label_active   && length $label_active)   ? substr(trim_str($label_active),   0, 64) : '';
        $label_inactive = (defined $label_inactive && length $label_inactive) ? substr(trim_str($label_inactive), 0, 64) : '';
        push @clean, {
            uuid                    => $d->{uuid},
            enabled                 => ($d->{enabled} ? JSON::PP::true : JSON::PP::false),
            friendlyName            => trim_str($d->{friendlyName} // ''),
            displayCategory         => ($valid_cat{$d->{displayCategory} || ''} ? $d->{displayCategory} : 'OTHER'),
            capabilities            => $caps,
            # Uniform `exists`-check pattern for all boolean per-device
            # flags. Distinguishes "field omitted from payload" (use this
            # field's CGI default) from "explicitly false". The CGI default
            # is per-field (not per-type — the CGI has no structure cache),
            # so for type-dependent defaults (rangeAxisInverted) the JS UI
            # is still responsible for seeding the type-correct value at
            # addDevice() time. The CGI default applies only when the
            # field is truly absent (hand-edited devices.json, etc.).
            rangeAxisInverted       => (exists $d->{rangeAxisInverted}
                                        ? ($d->{rangeAxisInverted} ? JSON::PP::true : JSON::PP::false)
                                        : JSON::PP::false),
            thermostatUseOverride   => (exists $d->{thermostatUseOverride}
                                        ? ($d->{thermostatUseOverride} ? JSON::PP::true : JSON::PP::false)
                                        : JSON::PP::false),
            thermostatOverrideHours => $override_hours,
            audioVolumeStep         => $vol_step,
            # Sensor polarity (Motion/Contact). Default TRUE — the only
            # boolean here whose default flips from false; matches the
            # type-default for every sensor type so the CGI can hardcode it.
            sensorPolarityInverted  => (exists $d->{sensorPolarityInverted}
                                        ? ($d->{sensorPolarityInverted} ? JSON::PP::true : JSON::PP::false)
                                        : JSON::PP::true),
            ventilationOverrideHours => $vent_hours,
            modeLabelActive          => $label_active,
            modeLabelInactive        => $label_inactive,
            msNo                    => (($d->{msNo} // '') =~ /^\d+$/ ? $d->{msNo} + 0 : 1),
            addedAt                 => $d->{addedAt} // $now,
            updatedAt               => $now,
        };
    }
    return \@clean;
}

# Sanitize globals from a payload (either inbound form-POST or on-disk read).
# Defaults: master enabled = TRUE (fail-safe: open), vacation gate enabled =
# FALSE.
sub sanitize_globals_in {
    my ($raw) = @_;
    $raw = {} unless ref $raw eq 'HASH';
    my $vg = (ref $raw->{vacationGate} eq 'HASH') ? $raw->{vacationGate} : {};
    # vacationGate watches a user-chosen Loxone control/state UUID. Legacy
    # operatingModeIndex is intentionally dropped (never worked for custom
    # Betriebsarten — no Loxone read API). Accept a UUID-ish string only.
    my $cuid = $vg->{controlUuid};
    $cuid = (defined $cuid && $cuid =~ /^[0-9A-Fa-f-]{8,}$/) ? "$cuid" : undef;
    return {
        enabled => (defined $raw->{enabled} && !$raw->{enabled}) ? JSON::PP::false : JSON::PP::true,
        vacationGate => {
            enabled => $vg->{enabled} ? JSON::PP::true : JSON::PP::false,
            controlUuid => $cuid,
        },
    };
}

sub read_state {
    my $default = {
        bridge     => { connected => 0, lastError => undef, lastConnectedAt => undef },
        miniserver => { connected => 0, lastError => undef, eventsSeen => 0, lastEventAt => undef },
        lastDirectiveAt => undef,
    };
    return $default unless -r $STATE_JSON;
    open(my $fh, '<', $STATE_JSON) or return $default;
    local $/;
    my $json = <$fh>;
    close $fh;
    my $data = eval { decode_json($json) };
    return $data || $default;
}

# Daemon liveness via the PID file. We could shell out to `control.sh status`
# but that's an extra fork; reading the file + kill 0 is sub-millisecond.
sub read_daemon_status {
    return { running => 0, pid => undef } unless -r $DAEMON_PID_FILE;
    open(my $fh, '<', $DAEMON_PID_FILE) or return { running => 0, pid => undef };
    my $pid = <$fh>;
    close $fh;
    chomp $pid if defined $pid;
    return { running => 0, pid => undef } unless $pid && $pid =~ /^\d+$/;
    # kill 0 → just checks signalability without actually sending anything.
    if (kill 0, $pid) {
        return { running => 1, pid => $pid };
    }
    return { running => 0, pid => undef };
}

sub read_pairings {
    return [] unless -r $PAIRINGS_JSON;
    open(my $fh, '<', $PAIRINGS_JSON) or return [];
    local $/;
    my $json = <$fh>;
    close $fh;
    my $data = eval { decode_json($json) };
    return [] unless ref $data eq 'HASH';
    # pairings.json is { pairingId => { name, firstSeen, lastSeen, count, lastDirective, revoked?, revokedAt? } }.
    # Flatten to a list and sort most-recent-first so the template loop is trivial.
    # `revoked` is set by bin/src/pairings.js when Lambda flags an Alexa account
    # as needing re-link (LWA refresh-token revoked). See HEALTH_REVOKED_COUNT
    # below for the summary the UI banner reads.
    my @list;
    for my $id (keys %$data) {
        my $row = $data->{$id};
        push @list, {
            ID             => $id,
            NAME           => $row->{name}          // '',
            FIRST_SEEN     => $row->{firstSeen}     // '',
            LAST_SEEN      => $row->{lastSeen}      // '',
            COUNT          => $row->{count}         // 0,
            LAST_DIRECTIVE => $row->{lastDirective} // '',
            REVOKED        => $row->{revoked}     ? 1  : 0,
            REVOKED_AT     => $row->{revokedAt}     // '',
        };
    }
    @list = sort { ($b->{LAST_SEEN} || '') cmp ($a->{LAST_SEEN} || '') } @list;
    return \@list;
}

sub read_userid {
    return '' unless -r $IDENTITY_USERID;
    open(my $fh, '<', $IDENTITY_USERID) or return '';
    my $uid = <$fh>;
    close $fh;
    chomp $uid if defined $uid;
    return $uid || '';
}

# Parse the daemon.env sh-style file into a hash. Returns {} if missing or
# unreadable — the template then falls back to defaults so the Settings form
# is still usable on a fresh install where daemon.env doesn't exist yet.
sub read_daemon_env {
    my %env;
    return \%env unless -r $DAEMON_ENV;
    open(my $fh, '<', $DAEMON_ENV) or return \%env;
    while (my $line = <$fh>) {
        chomp $line;
        next if $line =~ /^\s*(#|$)/;          # comments + blank lines
        next unless $line =~ /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/;
        my ($k, $v) = ($1, $2);
        # Strip surrounding single or double quotes if present.
        $v =~ s/^['"]//;
        $v =~ s/['"]$//;
        $env{$k} = $v;
    }
    close $fh;
    return \%env;
}

# Atomically rewrite daemon.env with the two managed keys. Any user-added
# keys not in our known set are lost — by design (the warning in the header
# comment tells the user this).
#
# LOG_LEVEL is deliberately NOT written here: it is read from LoxBerry's
# per-plugin level on every daemon start (control.sh → log-session-create.pl
# exports LOG_LEVEL just before nohup node). Keeping a stale LOG_LEVEL in
# daemon.env would create a second source of truth.
#
# Returns '' on success, error message on failure.
sub write_daemon_env {
    my ($url, $port) = @_;
    my $tmp = "$DAEMON_ENV.tmp.$$";

    my $body = <<"EOF";
# Aloxberry daemon runtime config — managed by the plugin web UI.
# Hand-edits are preserved until the next "Save settings" click in the UI,
# at which point this file is regenerated with only the two keys below.
# No secrets belong here — the daemon manages its own identity files under
# $lbpconfigdir/identity/.
# LOG_LEVEL is NOT in this file: control.sh reads it from LoxBerry's
# per-plugin level (the value the Logs tab's "Aktueller Log-Level" widget
# shows) and exports it at start. Single source of truth.

# Public URL of the Aloxberry dispatch bridge. Required.
BRIDGE_URL=$url

# Loopback HTTP port the CGI talks to. Change only if the default is taken
# on this LoxBerry by another plugin.
LOCAL_HTTP_PORT=$port
EOF

    open(my $fh, '>', $tmp) or return "open $tmp: $!";
    print $fh $body;
    close $fh or return "close $tmp: $!";
    chmod 0600, $tmp;
    rename($tmp, $DAEMON_ENV) or do {
        unlink $tmp;
        return "rename: $!";
    };
    return '';
}

sub trim_str {
    my ($s) = @_;
    return '' unless defined $s;
    $s =~ s/^\s+|\s+$//g;
    return $s;
}
