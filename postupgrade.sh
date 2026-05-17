#!/bin/bash

# Shell script which is executed in case of an update (if this plugin is already
# installed on the system). This script is after main installation is done  (*AFTER*
# postinstall.sh) and can be used e.g. to save existing configfiles to /tmp
# during installation. Use with caution and remember, that all systems may be
# different!
#
# Exit code must be 0 if executed successfull.
# Exit code 1 gives a warning but continues installation.
# Exit code 2 cancels installation.
#
# Will be executed as user "loxberry".
#
# You can use all vars from /etc/environment in this script.
#
# We add 5 additional arguments when executing this script:
# command <TEMPFOLDER> <NAME> <FOLDER> <VERSION> <BASEFOLDER>
#
# For logging, print to STDOUT. You can use the following tags for showing
# different colorized information during plugin installation:
#
# <OK> This was ok!"
# <INFO> This is just for your information."
# <WARNING> This is a warning!"
# <ERROR> This is an error!"
# <FAIL> This is a fail!"

# To use important variables from command line use the following code:
COMMAND=$0    # Zero argument is shell command
PTEMPDIR=$1   # First argument is temp folder during install
PSHNAME=$2    # Second argument is Plugin-Name for scipts etc.
PDIR=$3       # Third argument is Plugin installation folder
PVERSION=$4   # Forth argument is Plugin version
#LBHOMEDIR=$5 # Comes from /etc/environment now. Fifth argument is
              # Base folder of LoxBerry
PTEMPPATH=$6  # Sixth argument is full temp path during install (see also $1)

# Combine them with /etc/environment
PHTMLAUTH=$LBHOMEDIR/webfrontend/htmlauth/plugins/$PDIR
PHTML=$LBPHTML/$PDIR
PTEMPL=$LBPTEMPL/$PDIR
PDATA=$LBPDATA/$PDIR
PLOGS=$LBPLOG/$PDIR # Note! This is stored on a Ramdisk now!
PCONFIG=$LBPCONFIG/$PDIR
PSBIN=$LBPSBIN/$PDIR
PBIN=$LBPBIN/$PDIR

echo "<INFO> Aloxberry: POSTUPGRADE — PDIR=$PDIR PVERSION=$PVERSION PTEMPPATH=$PTEMPPATH"
echo "<INFO> Aloxberry: POSTUPGRADE — PCONFIG=$PCONFIG PDATA=$PDATA PBIN=$PBIN"

# Log $PCONFIG state on entry — if it was wiped by LoxBerry's unpack step
# we'll see that here, and the restore that follows will fill it back in.
echo "<INFO> Aloxberry: POSTUPGRADE — inspecting $PCONFIG before restore:"
if [ -d "$PCONFIG" ]; then
    ls -la "$PCONFIG" 2>&1 | sed 's/^/<INFO>   /'
    if [ -f "$PCONFIG/identity/userId" ]; then
        UID_CUR="$(cat "$PCONFIG/identity/userId" 2>/dev/null)"
        echo "<INFO> Aloxberry: POSTUPGRADE — current userId on disk=$UID_CUR"
    else
        echo "<INFO> Aloxberry: POSTUPGRADE — no userId on disk (will be restored from backup)"
    fi
else
    echo "<INFO> Aloxberry: POSTUPGRADE — $PCONFIG missing before restore (will be restored from backup)"
fi

echo "<INFO> Aloxberry: POSTUPGRADE — restoring config/data/logs from $PTEMPPATH/upgrade ..."
[ -d "$PTEMPPATH/upgrade/config" ] && cp -p -r $PTEMPPATH/upgrade/config/. $PCONFIG/ 2>/dev/null
[ -d "$PTEMPPATH/upgrade/data" ]   && cp -p -r $PTEMPPATH/upgrade/data/.   $PDATA/   2>/dev/null
[ -d "$PTEMPPATH/upgrade/logs" ]   && cp -p -r $PTEMPPATH/upgrade/logs/.   $PLOGS/   2>/dev/null

# Verify the restore landed — specifically the identity file, since that's
# what determines whether existing Alexa pairings survive the upgrade.
if [ -f "$PCONFIG/identity/userId" ]; then
    UID_AFTER="$(cat "$PCONFIG/identity/userId" 2>/dev/null)"
    echo "<OK> Aloxberry: POSTUPGRADE — identity restored (userId=$UID_AFTER)"
else
    echo "<ERROR> Aloxberry: POSTUPGRADE — identity userId file MISSING after restore"
    echo "<ERROR>                   Existing Alexa pairings WILL break; re-pair required."
fi

echo "<INFO> Aloxberry: POSTUPGRADE — removing temp folders"
rm -rf $PTEMPPATH/upgrade

# Start the daemon. Two notes on why this is `restart` instead of `start`:
#   1. postinstall.sh's auto-start is now gated to skip during upgrades
#      (it detects the marker file we wrote in preupgrade.sh), so no daemon
#      should be running here. `restart` is `stop + start` and the stop is
#      a no-op when no daemon is running, so this is harmless.
#   2. If some future change accidentally leaves a daemon running here,
#      `restart` ensures the daemon picks up the *restored* identity from
#      disk rather than continuing with whatever was in memory before. This
#      is the bug we just hunted: a still-running daemon doesn't re-read
#      the file when it's restored.
if [ -f "$PTEMPPATH/_daemon_was_running" ]; then
    echo "<INFO> Aloxberry: POSTUPGRADE — daemon was running before upgrade; restarting ..."
    if "$PBIN/control.sh" restart; then
        echo "<OK> Aloxberry: POSTUPGRADE — daemon restarted."
    else
        echo "<WARNING> Aloxberry: POSTUPGRADE — daemon did not restart cleanly; check $PLOGS"
    fi
else
    echo "<INFO> Aloxberry: POSTUPGRADE — daemon was not running before upgrade; not starting."
fi

echo "<OK> Aloxberry: POSTUPGRADE — completed"
exit 0
