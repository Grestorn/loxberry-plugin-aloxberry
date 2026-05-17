#!/usr/bin/perl
# Read-only probe: verifies what credentials LoxBerry currently has on disk,
# WITHOUT contacting the Miniserver. Never prints any secret value — only
# field shape (username, password length, character-class fingerprint).
#
# Output is safe to share/log.
use strict;
use warnings;
use LoxBerry::System;

# Find and stat general.cfg to detect staleness vs. last UI edit.
my $cfg_path = '/opt/loxberry/config/system/general.cfg';
my $json_path = '/opt/loxberry/config/system/general.json';
for my $f ($cfg_path, $json_path) {
    if (-f $f) {
        my @s = stat($f);
        my $mtime = $s[9];
        my $age = time - $mtime;
        printf("%s  mtime=%s  age=%ds (%.1fh)\n", $f, scalar(localtime($mtime)), $age, $age/3600);
    } else {
        print "$f  (missing)\n";
    }
}

print "\n";

my %ms = LoxBerry::System::get_miniservers();
for my $no (sort { $a <=> $b } keys %ms) {
    my $m = $ms{$no};
    print "miniserver $no:\n";
    print "  name        = ", $m->{Name} // '(undef)', "\n";
    print "  ipaddress   = ", $m->{IPAddress} // '(undef)', "\n";
    print "  admin/user  = ", $m->{Admin} // '(undef)', "\n";   # username — safe to print

    # Password — only fingerprint, never the value.
    my $pw = $m->{Pass} // '';
    my $len = length($pw);
    my $classes = '';
    $classes .= 'a' if $pw =~ /[a-z]/;
    $classes .= 'A' if $pw =~ /[A-Z]/;
    $classes .= '0' if $pw =~ /[0-9]/;
    $classes .= 'S' if $pw =~ /[^a-zA-Z0-9]/;
    $classes ||= '(empty)';
    print "  pass.length = $len  pass.charclasses=$classes\n";
}
