#!/usr/bin/perl
# One-shot probe of LoxBerry::System::get_miniservers() return shape.
# Output: list of keys for MS 1, with redacted values (just types/lengths).
use strict;
use warnings;
use LoxBerry::System;

my %ms = LoxBerry::System::get_miniservers();

for my $no (sort keys %ms) {
    print "=== miniserver $no ===\n";
    my $m = $ms{$no};
    for my $k (sort keys %$m) {
        my $v = $m->{$k};
        # Redact obviously-sensitive fields by length; show others
        if ($k =~ /pass|secret|token|cert/i) {
            my $len = defined $v ? length($v) : 0;
            print "  $k = <redacted, length=$len>\n";
        } else {
            my $shown = defined $v ? (length($v) > 60 ? substr($v, 0, 60) . "..." : $v) : "<undef>";
            print "  $k = $shown\n";
        }
    }
}
