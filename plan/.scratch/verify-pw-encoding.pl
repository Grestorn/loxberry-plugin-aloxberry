#!/usr/bin/perl
# Compare the password bytes that get_miniservers() returns against the
# raw bytes from general.cfg / general.json — to detect any LoxBerry-side
# transcoding (URL-encoding, HTML entities, base64, JSON unescaping) that
# would make our `password` different from what Loxone Config stored.
#
# Never prints the actual password — only byte-level fingerprints.
use strict;
use warnings;
use LoxBerry::System;

sub fingerprint {
    my ($bytes) = @_;
    my $len = length($bytes);
    my $classes = '';
    $classes .= 'a' if $bytes =~ /[a-z]/;
    $classes .= 'A' if $bytes =~ /[A-Z]/;
    $classes .= '0' if $bytes =~ /[0-9]/;
    $classes .= 'S' if $bytes =~ /[^a-zA-Z0-9]/;
    # SHA1 of the bytes — usable as a "are these two the same string?" check
    # across sources without revealing content. (Not security-grade — just
    # a comparison fingerprint.)
    require Digest::SHA;
    my $sha = Digest::SHA::sha1_hex($bytes);
    # Byte-class histogram: count of each byte category
    my $bs = 0; my $bdash = 0; my $balnum = 0; my $bspecial = 0;
    for my $i (0 .. $len-1) {
        my $c = substr($bytes, $i, 1);
        $bs++       if $c eq ' ';
        $bdash++    if $c eq '-';
        $balnum++   if $c =~ /[a-zA-Z0-9]/;
        $bspecial++ if $c =~ /[^a-zA-Z0-9\s\-]/;
    }
    return "len=$len classes=$classes sha1=$sha spaces=$bs dashes=$bdash alnum=$balnum special=$bspecial";
}

print "=== LoxBerry::System::get_miniservers() ===\n";
my %ms = LoxBerry::System::get_miniservers();
my $api_pw = $ms{1}{Pass} // '';
print "  Pass: ", fingerprint($api_pw), "\n";
print "  Pass_RAW: ", fingerprint($ms{1}{Pass_RAW} // ''), "\n";

print "\n=== general.cfg raw line ===\n";
if (open(my $fh, '<:raw', '/opt/loxberry/config/system/general.cfg')) {
    while (my $line = <$fh>) {
        if ($line =~ /^Pass=(.*)$/i) {
            my $raw = $1;
            $raw =~ s/[\r\n]+$//;
            print "  raw cfg line 'Pass=...': ", fingerprint($raw), "\n";
            last;
        }
    }
    close $fh;
}

print "\n=== general.json raw 'Pass' field ===\n";
if (open(my $fh, '<:raw', '/opt/loxberry/config/system/general.json')) {
    local $/;
    my $content = <$fh>;
    close $fh;
    require JSON;
    my $parsed = JSON::decode_json($content);
    # Walk to find the Pass field for miniserver 1
    my $pw_from_json;
    for my $key (keys %$parsed) {
        if (ref($parsed->{$key}) eq 'HASH' && exists $parsed->{$key}{Pass}) {
            $pw_from_json = $parsed->{$key}{Pass};
            last;
        }
    }
    if (defined $pw_from_json) {
        print "  json 'Pass': ", fingerprint($pw_from_json), "\n";
    } else {
        # try a deeper walk
        sub walk;
        sub walk {
            my ($node) = @_;
            return unless ref($node);
            if (ref($node) eq 'HASH') {
                for my $k (keys %$node) {
                    if ($k =~ /^Pass$/i && !ref($node->{$k})) {
                        print "  json node->{Pass}: ", fingerprint($node->{$k}), "\n";
                    } else { walk($node->{$k}); }
                }
            } elsif (ref($node) eq 'ARRAY') {
                walk($_) for @$node;
            }
        }
        walk($parsed);
    }
}

print "\n(If the SHA1 fingerprints match across sources, the password is\n";
print "the same bytes everywhere — meaning the password we'd send IS what\n";
print "LoxBerry has on disk. If they differ, that's the bug.)\n";
