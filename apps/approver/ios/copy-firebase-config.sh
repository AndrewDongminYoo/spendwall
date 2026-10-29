#!/bin/sh
set -eu
config_source="${SRCROOT}/Runner/GoogleService-Info.plist"
config_destination="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/GoogleService-Info.plist"
if [ -f "${config_source}" ]; then
	cp "${config_source}" "${config_destination}"
elif [ -f "${config_destination}" ]; then
	rm "${config_destination}"
fi
