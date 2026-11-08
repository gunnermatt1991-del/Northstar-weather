import os, time, hashlib
from pathlib import Path
from datetime import datetime, timedelta, timezone
from io import BytesIO
import requests
import numpy as np
import xarray as xr
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
STEPS={"gfs":list(range(0,121))+list(range(123,385,3)),"ecmwf":list(range(0,145,3))+list(range(150,241,6))}

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
 path=cachefile(f"ecmwf-{day}-{cyc}-{hour}-{field}")
 if path.exists() and time.time()-path.stat().st_mtime<21600:return path
 client=Client(source="ecmwf",model="ifs",resol="0p25")
 common={"date":day,"time":int(cyc),"step":hour,"stream":"oper","type":"fc","target":str(path)}
 try:
  if field=="z500":client.retrieve(**common,param="z",levelist=500)
  elif field=="t850":client.retrieve(**common,param="t",levelist=850)
  else:
   param={"mslp":"msl","temperature":"2t","precipitation":"tp","wind":"10si"}[field]
   client.retrieve(**common,param=param)
 except Exception as e:
  path.unlink(missing_ok=True);raise HTTPException(502,f"ECMWF retrieval failed: {e}")
 return path
def choose_dataset(path,field):
 datasets=xr.open_datasets(path,engine="cfgrib",backend_kwargs={"indexpath":""})
 wanted={"mslp":["msl"],"temperature":["t2m"],"precipitation":["tp"],"wind":["si10","10si","ws","u10","u"],"z500":["gh","z"],"t850":["t"]}[field]
 for ds in datasets:
  for var in wanted:
   if var in ds.data_vars:
    if field in ("z500","t850"):
     coord=next((k for k in ds.coords if k in ("isobaricInhPa","pressure_level")),None)
     if coord and int(np.asarray(ds[coord].values).flat[0]) not in (500 if field=="z500" else 850,):continue
    return ds,var,datasets
 raise ValueError(f"GRIB field not found; expected {wanted}")
def render(path,field,model,day,cyc,hour):
 try:
  ds,var,all_ds=choose_dataset(path,field); da=ds[var].squeeze()
  if field=="wind" and var in ("u10","u"): 
   vds=next((d for d in all_ds if "v10" in d.data_vars or "v" in d.data_vars),None)
   if vds is not None:da=np.hypot(da,vds["v10" if "v10" in vds.data_vars else "v"].squeeze())
  vals=np.asarray(da.values,dtype=float)
  if field=="mslp":vals=vals/100
  if field=="temperature" or field=="t850":vals=vals-273.15
  if field=="precipitation":vals=vals*1000
  if field=="z500":vals=vals/10
  lat=ds["latitude"].values;lon=ds["longitude"].values
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
 except Exception as e:raise HTTPException(422,f"Unable to decode or render {field}: {e}")
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
