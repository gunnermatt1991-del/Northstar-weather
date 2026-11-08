# Northstar GFS + ECMWF chart engine

Server-side GRIB2 retrieval and UK chart rendering for the Professional Models page.

- NOAA/NCEP GFS 0.25° NOMADS: 00/06/12/18 UTC, hourly to +120h then every 3h to +384h.
- ECMWF IFS HRES Open Data 0.25°: 00/12 UTC, every 3h to +144h then every 6h to +240h.
- Chart fields: MSLP, 2m temperature, precipitation, 10m wind, 500 hPa height and 850 hPa temperature.

## Run locally
```bash
docker build -t northstar-model-engine .
docker run --rm -p 8080:8080 -e APP_ORIGIN=https://gunnermatt1991-del.github.io northstar-model-engine
```
Check `/health`, `/api/runs?model=gfs`, `/api/runs?model=ecmwf`.
Example: `/api/chart?model=gfs&date=YYYYMMDD&cycle=00&hour=24&field=mslp`.

Deploy this container to a Python container host (Cloud Run, Render, Railway, etc.) and set APP_ORIGIN to the GitHub Pages origin. The browser must call this API; never download GRIB files in the browser. The engine checks provider files rather than assuming a run exists from the clock, and caches downloaded fields for six hours.

This repository addition is the engine source, not a deployed public service. A container host must be configured before the website can display charts.
