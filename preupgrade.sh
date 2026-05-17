#!/bin/bash

# Shell script which is executed in case of an update (if this plugin is already
# installed on the system). This script is executed as very first step (*BEFORE*
# preinstall.sh) and can be used e.g. to save existing configfiles to /tmp
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
PCGI=$LBPCGI/$PDIR
PHTML=$LBPHTML/$PDIR
PTEMPL=$LBPTEMPL/$PDIR
PDATA=$LBPDATA/$PDIR
PLOGS=$LBPLOG/$PDIR # Note! This is stored on a Ramdisk now!
PCONFIG=$LBPCONFIG/$PDIR
PSBIN=$LBPSBIN/$PDIR
PBIN=$LBPBIN/$PDIR

echo "<INFO> Aloxberry: PREUPGRADE — PDIR=$PDIR PVERSION=$PVERSION PTEMPPATH=$PTEMPPATH"
echo "<INFO> Aloxberry: PREUPGRADE — PCONFIG=$PCONFIG PDATA=$PDATA PBIN=$PBIN"

# Stop the daemon before the upgrade rewrites $LBPBIN. We delegate to the
# control.sh on disk (still the OLD version at this point — the upgrade hasn't
# overwritten it yet). Record whether the daemon was running so postupgrade
# can decide whether to restart.
if [ -x "$PBIN/control.sh" ]; then
    if "$PBIN/control.sh" status >/dev/null 2>&1; then
        echo "1" > "$PTEMPPATH/_daemon_was_running"
        echo "<INFO> Aloxberry: PREUPGRADE — daemon is running; marker written, stopping ..."
        "$PBIN/control.sh" stop || true
        echo "<INFO> Aloxberry: PREUPGRADE — daemon stop completed."
    else
        echo "<INFO> Aloxberry: PREUPGRADE — daemon was not running; nothing to stop, no marker written."
    fi
else
    echo "<INFO> Aloxberry: PREUPGRADE — control.sh not found at $PBIN/control.sh (first install?)"
fi

echo "<INFO> Aloxberry: PREUPGRADE — creating temp folders under $PTEMPPATH/upgrade"
mkdir -p $PTEMPPATH/upgrade
mkdir -p $PTEMPPATH/upgrade/config
mkdir -p $PTEMPPATH/upgrade/data
mkdir -p $PTEMPPATH/upgrade/logs

# Log the pre-backup state so we can diagnose loss issues. The identity
# files matter the most — if we don't see them here, every Alexa pairing
# is going to break on this upgrade.
echo "<INFO> Aloxberry: PREUPGRADE — inspecting $PCONFIG before backup:"
if [ -d "$PCONFIG" ]; then
    ls -la "$PCONFIG" 2>&1 | sed 's/^/<INFO>   /'
    if [ -d "$PCONFIG/identity" ]; then
        echo "<INFO> Aloxberry: PREUPGRADE — identity dir contents:"
        ls -la "$PCONFIG/identity" 2>&1 | sed 's/^/<INFO>   /'
        if [ -f "$PCONFIG/identity/userId" ]; then
            UID_VAL="$(cat "$PCONFIG/identity/userId" 2>/dev/null)"
            echo "<INFO> Aloxberry: PREUPGRADE — current userId=$UID_VAL"
        fi
    else
        echo "<WARNING> Aloxberry: PREUPGRADE — no identity dir at $PCONFIG/identity"
    fi
else
    echo "<WARNING> Aloxberry: PREUPGRADE — $PCONFIG does not exist before backup"
fi

echo "<INFO> Aloxberry: PREUPGRADE — backing up config/data/logs ..."
[ -d "$PCONFIG" ] && cp -p -r $PCONFIG/. $PTEMPPATH/upgrade/config/ 2>/dev/null
[ -d "$PDATA" ]   && cp -p -r $PDATA/.   $PTEMPPATH/upgrade/data/   2>/dev/null
[ -d "$PLOGS" ]   && cp -p -r $PLOGS/.   $PTEMPPATH/upgrade/logs/   2>/dev/null

# Log what we actually managed to back up — silent `2>/dev/null` above
# can mask permission errors. The identity files are the load-bearing
# bit; explicit log so we know the backup is intact.
if [ -f "$PTEMPPATH/upgrade/config/identity/userId" ]; then
    BACKED_UID="$(cat "$PTEMPPATH/upgrade/config/identity/userId" 2>/dev/null)"
    echo "<OK> Aloxberry: PREUPGRADE — identity backed up (userId=$BACKED_UID)"
else
    echo "<WARNING> Aloxberry: PREUPGRADE — identity userId file NOT backed up (would cause re-pair after upgrade)"
fi

echo "<OK> Aloxberry: PREUPGRADE — completed"
exit 0
