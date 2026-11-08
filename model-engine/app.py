import os, time, hashlib, traceback
from pathlib import Path
from datetime import datetime, timedelta, timezone
from io import BytesIO
import requests
import numpy as np
import cfgrib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import cartopy.crs as ccrs
import cartopy.feature as cfeature
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from ecmwf.opendata import Client

APP_ORIGIN=os.getenv("APP_ORIGIN","https://gunnermatt1991-del.github.io")
CACHE=Path(os.getenv("CACHE_DIR","/tmp/northstar-model-cache")); CACHE.mkdir(parents=True,exist_ok=True)
app=FastAPI(title="Northstar Operational Model Charts",version="1.0")
app.add_middleware(CORSMiddleware,allow_origins=[APP_ORIGIN],allow_methods=["GET"],allow_headers=["*"])
UK=[-11.0,3.5,49.0,61.5]
FIELDS={
 "mslp":{"title":"Mean sea-level pressure","units":"hPa","cmap":"viridis"},
 "temperature":{"title":"2m temperature","units":"°C","cmap":"coolwarm"},
 "precipitation":{"title":"Total precipitation","units":"mm","cmap":"Blues"},
 "wind":{"title":"10m wind speed","units":"m/s","cmap":"magma"},
 "z500":{"title":"500 hPa geopotential height","units":"dam","cmap":"plasma"},
 "t850":{"title":"850 hPa temperature","units":"°C","cmap":"coolwarm"}}
CYCLES={"gfs":["00","06","12","18"],"ecmwf":["00","12"]}
STEPS={"gfs":list(range(0,121))+list(range(123,385,3)),"ecmwf":list(range(3,145,3))+list(range(150,241,6))}

def dt(day,cycle):
 return datetime.strptime(day+cycle,"%Y%m%d%H").replace(tzinfo=timezone.utc)
def cachefile(key):
 return CACHE/(hashlib.sha256(key.encode()).hexdigest()+".grib2")
def head_ok(url):
 try:return requests.head(url,timeout=15).status_code==200
 except requests.RequestException:return False
def latest(model):
 now=datetime.now(timezone.utc)
 for back in range(0,3):
  day=(now-timedelta(days=back)).strftime("%Y%m%d")
  for cyc in (["18","12","06","00"] if model=="gfs" else ["12","00"]):
   if dt(day,cyc)>now-timedelta(hours=4 if model=="gfs" else 8):continue
   if model=="gfs":
    url=f"https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/gfs.{day}/{cyc}/atmos/gfs.t{cyc}z.pgrb2.0p25.f000"
   else:
    stamp=day+cyc+"0000"
    url=f"https://data.ecmwf.int/forecasts/{day}/{cyc}z/ifs/0p25/oper/{stamp}-3h-oper-fc.grib2"
   if head_ok(url):return day,cyc
 raise HTTPException(503,f"No recent {model.upper()} run found at the provider.")
@app.get("/health")
def health():return {"ok":True,"service":"northstar-model-engine","models":["gfs","ecmwf"]}
@app.get("/api/runs")
def runs(model:str=Query(...,pattern="^(gfs|ecmwf)$")):
 day,cyc=latest(model)
 return {"model":model,"date":day,"cycle":cyc,"run":f"{day} {cyc}Z","max_hour":384 if model=="gfs" else 240,"steps":STEPS[model],"fields":list(FIELDS),"source":"NOAA/NCEP NOMADS" if model=="gfs" else "ECMWF IFS Open Data"}
def gfs_download(day,cyc,hour,field):
 filename=f"gfs.t{cyc}z.pgrb2.0p25.f{hour:03d}"
 params={"file":filename,"dir":f"/gfs.{day}/{cyc}/atmos","subregion":"","leftlon":UK[0],"rightlon":UK[1],"toplat":UK[3],"bottomlat":UK[2]}
 if field=="mslp":params.update(var_PRMSL="on",lev_mean_sea_level="on")
 elif field=="temperature":params.update(var_TMP="on",lev_2_m_above_ground="on")
 elif field=="precipitation":params.update(var_APCP="on",lev_surface="on")
 elif field=="wind":params.update(var_UGRD="on",var_VGRD="on",lev_10_m_above_ground="on")
 elif field=="z500":params.update(var_HGT="on",lev_500_mb="on")
 elif field=="t850":params.update(var_TMP="on",lev_850_mb="on")
 key=f"gfs-{day}-{cyc}-{hour}-{field}";path=cachefile(key)
 if path.exists() and time.time()-path.stat().st_mtime<21600:return path
 r=requests.get("https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl",params=params,timeout=180);r.raise_for_status()
 if len(r.content)<1000 or b"<html" in r.content[:300].lower():raise HTTPException(502,"NOAA returned an empty or invalid GRIB file.")
 path.write_bytes(r.content);return path
def ecmwf_download(day,cyc,hour,field):
 # Download the official per-step HRES GRIB file directly. The ECMWF
 # subset client has intermittently returned 502s for parameter-selective
 # requests; the public Open Data file URL is stable and contains all
 # fields for this forecast step. Cache once per run/step so subsequent
 # chart fields reuse the same GRIB file.
 path=cachefile(f"ecmwf-full-{day}-{cyc}-{hour}")
 if path.exists() and time.time()-path.stat().st_mtime<21600 and path.stat().st_size>1000:
  return path
 stamp=day+cyc+"0000"
 url=f"https://data.ecmwf.int/forecasts/{day}/{cyc}z/ifs/0p25/oper/{stamp}-{hour}h-oper-fc.grib2"
 try:
  with requests.get(url,stream=True,timeout=(20,300),headers={"User-Agent":"Northstar-Weather/1.0"}) as response:
   if response.status_code==404:
    raise HTTPException(503,f"ECMWF HRES file is not published yet for {day} {cyc}Z +{hour}h.")
   response.raise_for_status()
   tmp=path.with_suffix(".download")
   total=0
   with open(tmp,"wb") as output:
    for chunk in response.iter_content(chunk_size=1024*1024):
     if chunk:
      output.write(chunk);total+=len(chunk)
   if total<1000:
    tmp.unlink(missing_ok=True)
    raise RuntimeError("ECMWF returned an empty GRIB file")
   with open(tmp,"rb") as check:
    if check.read(4)!=b"GRIB":
     tmp.unlink(missing_ok=True)
     raise RuntimeError("ECMWF response was not a GRIB2 file")
   tmp.replace(path)
  return path
 except HTTPException:
  raise
 except Exception as e:
  path.unlink(missing_ok=True)
  raise HTTPException(502,f"ECMWF Open Data download failed for {day} {cyc}Z +{hour}h: {type(e).__name__}: {e}")

def choose_dataset(path,field,model="gfs"):
 # Open exactly one GRIB message family at a time. cfgrib.open_datasets()
 # scans the entire mixed ECMWF HRES file and can raise AssertionError
 # while trying to build incompatible multi-level hypercubes.
 levels={
  "mslp":{"typeOfLevel":"meanSea"},
  "temperature":{"typeOfLevel":"heightAboveGround","level":2},
  "precipitation":{"typeOfLevel":"surface"},
  "wind":{"typeOfLevel":"heightAboveGround","level":10},
  "z500":{"typeOfLevel":"isobaricInhPa","level":500},
  "t850":{"typeOfLevel":"isobaricInhPa","level":850}}
 names={
  "gfs":{"mslp":["prmsl"],"temperature":["2t"],"precipitation":["tp"],"wind":["10u","10v"],"z500":["gh"],"t850":["t"]},
  "ecmwf":{"mslp":["msl"],"temperature":["2t"],"precipitation":["tp"],"wind":["10si","10u","10v"],"z500":["z"],"t850":["t"]}}
 errors=[]
 for short_name in names[model][field]:
  filters=dict(levels[field]);filters["shortName"]=short_name
  try:
   ds=cfgrib.open_dataset(str(path),backend_kwargs={"indexpath":"","filter_by_keys":filters})
   if short_name in ds.data_vars:
    return ds,short_name,[ds]
   if len(ds.data_vars)==1:
    var=next(iter(ds.data_vars))
    return ds,var,[ds]
   errors.append(f"{filters}: variables={list(ds.data_vars)}")
   ds.close()
  except Exception as e:
   errors.append(f"{filters}: {type(e).__name__}: {e}")
 # Some provider files use alternate level metadata; still constrain by
 # shortName so we never ask cfgrib to combine unrelated fields.
 for short_name in names[model][field]:
  try:
   ds=cfgrib.open_dataset(str(path),backend_kwargs={"indexpath":"","filter_by_keys":{"shortName":short_name}})
   if short_name in ds.data_vars:return ds,short_name,[ds]
   if len(ds.data_vars)==1:
    var=next(iter(ds.data_vars));return ds,var,[ds]
   errors.append(f"shortName={short_name}: variables={list(ds.data_vars)}");ds.close()
  except Exception as e:
   errors.append(f"shortName={short_name}: {type(e).__name__}: {e}")
 raise ValueError("Could not open requested GRIB field. "+" | ".join(errors))

def render(path,field,model,day,cyc,hour):
 try:
  ds,var,all_ds=choose_dataset(path,field,model); da=ds[var].squeeze()
  if field=="wind" and var in ("u10","u"): 
   vds=next((d for d in all_ds if "v10" in d.data_vars or "v" in d.data_vars),None)
   if vds is not None:da=np.hypot(da,vds["v10" if "v10" in vds.data_vars else "v"].squeeze())
  vals=np.asarray(da.values,dtype=float)
  if field=="mslp":vals=vals/100
  if field=="temperature" or field=="t850":vals=vals-273.15
  if field=="precipitation":vals=vals*1000
  if field=="z500":vals=vals/10
  lat_name=next((k for k in ("latitude","lat") if k in ds.coords),None);lon_name=next((k for k in ("longitude","lon") if k in ds.coords),None)
  if not lat_name or not lon_name:raise ValueError(f"GRIB grid coordinates missing; available coordinates: {list(ds.coords)}")
  lat=ds[lat_name].values;lon=ds[lon_name].values
  fig=plt.figure(figsize=(10,8),dpi=130);ax=plt.axes(projection=ccrs.PlateCarree())
  ax.set_extent(UK,crs=ccrs.PlateCarree());ax.add_feature(cfeature.LAND,facecolor="#e8e5d8");ax.add_feature(cfeature.OCEAN,facecolor="#dceaf4")
  ax.add_feature(cfeature.COASTLINE,linewidth=.7);ax.add_feature(cfeature.BORDERS,linewidth=.45)
  mesh=ax.pcolormesh(lon,lat,vals,cmap=FIELDS[field]["cmap"],shading="auto",transform=ccrs.PlateCarree())
  if field in ("mslp","z500"):
   try:ax.contour(lon,lat,vals,colors="#263548",linewidths=.55,transform=ccrs.PlateCarree())
   except Exception:pass
  cb=plt.colorbar(mesh,ax=ax,pad=.025,shrink=.82);cb.set_label(FIELDS[field]["units"])
  ax.set_title(f"Northstar · {model.upper()} · {FIELDS[field]['title']}\nRun {day} {cyc}Z · Forecast +{hour:03d}h",fontsize=13,weight="bold",pad=12)
  fig.text(.5,.025,"Source: NOAA/NCEP GFS" if model=="gfs" else "Source: ECMWF IFS Open Data · CC BY 4.0",ha="center",fontsize=8)
  fig.tight_layout(rect=[0,.045,1,1]);out=BytesIO();fig.savefig(out,format="png",bbox_inches="tight");plt.close(fig)
  for d in all_ds:
   try:d.close()
   except Exception:pass
  return out.getvalue()
 except Exception as e:raise HTTPException(422,f"Unable to decode or render {field}: {type(e).__name__}: {e!r}; traceback: {traceback.format_exc(limit=3)}")
@app.get("/api/chart")
def chart(model:str=Query(...,pattern="^(gfs|ecmwf)$"),date:str=Query(...,pattern="^\\d{8}$"),cycle:str=Query(...),hour:int=Query(...,ge=0),field:str=Query(...)):
 if field not in FIELDS:raise HTTPException(400,"Unsupported chart field.")
 if cycle not in CYCLES[model]:raise HTTPException(400,"This model does not publish that cycle.")
 if hour not in STEPS[model]:raise HTTPException(400,"This forecast hour is not published for the selected model.")
 try:datetime.strptime(date,"%Y%m%d")
 except ValueError:raise HTTPException(400,"Date must be YYYYMMDD.")
 path=gfs_download(date,cycle,hour,field) if model=="gfs" else ecmwf_download(date,cycle,hour,field)
 png=render(path,field,model,date,cycle,hour)
 return Response(png,media_type="image/png",headers={"Cache-Control":"public, max-age=1800","X-Northstar-Run":f"{date} {cycle}Z","X-Northstar-Forecast-Hour":str(hour)})
