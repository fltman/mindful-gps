#!/bin/bash
# Väntar in tile-bygget och startar sedan ruttservern. Körs en gång, i bakgrunden.
docker wait mindful-valhalla-build >/dev/null 2>&1
if docker logs mindful-valhalla-build 2>&1 | grep -q BYGGE_KLART; then
  docker rm -f mindful-valhalla >/dev/null 2>&1
  docker run -d --name mindful-valhalla -p 8002:8002 \
    -v "$PWD/valhalla/custom_files:/custom_files" \
    -e serve_tiles=True -e use_tiles_ignore_pbf=True -e force_rebuild=False \
    -e build_elevation=False -e build_admins=False -e build_time_zones=False \
    -e server_threads=8 \
    ghcr.io/gis-ops/docker-valhalla/valhalla:latest >/dev/null 2>&1
  echo "$(date +%H:%M) ruttservern startad på 8002"
else
  echo "$(date +%H:%M) BYGGET MISSLYCKADES — se docker logs mindful-valhalla-build"
fi
