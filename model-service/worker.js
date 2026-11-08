const ORIGIN = "https://gunnermatt1991-del.github.io";
const MODELS = {
  gfs: "ncep_gfs_global",
  ecmwf: "ecmwf_ifs025",
  ukmo_global: "ukmo_global_deterministic_10km",
  ukmo_uk: "ukmo_uk_deterministic_2km"
};
const HOURLY = "temperature_2m,precipitation,precipitation_probability,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover,geopotential_height_500hPa";
function reply(data, status=200) {
  return new Response(JSON.stringify(data), {status, headers:{
    "content-type":"application/json; charset=utf-8",
    "access-control-allow-origin":ORIGIN,
    "access-control-allow-methods":"GET, OPTIONS",
    "access-control-allow-headers":"content-type",
    "cache-control":"public, max-age=900"
  }});
}
export default {
 async fetch(request, env) {
  const url=new URL(request.url);
  if(request.method==="OPTIONS") return new Response(null,{status:204,headers:{
   "access-control-allow-origin":ORIGIN,"access-control-allow-methods":"GET, OPTIONS",
   "access-control-allow-headers":"content-type","access-control-max-age":"86400"
  }});
  if(request.headers.get("Origin")!==ORIGIN) return reply({error:"Origin not allowed"},403);
  if(request.method!=="GET" || url.pathname!=="/model") return reply({error:"Not found"},404);
  if(!env.OPEN_METEO_API_KEY) return reply({error:"Model service is not configured. Add the commercial Open-Meteo API key to the Worker secret OPEN_METEO_API_KEY."},503);
  const model=url.searchParams.get("model")||"gfs";
  const modelId=MODELS[model];
  if(!modelId) return reply({error:"Unsupported model"},400);
  const lat=Number(url.searchParams.get("latitude")??54.5);
  const lon=Number(url.searchParams.get("longitude")??-2.5);
  if(!Number.isFinite(lat)||lat < -90||lat>90||!Number.isFinite(lon)||lon < -180||lon>180) return reply({error:"Invalid coordinates"},400);
  const target=new URL("https://customer-api.open-meteo.com/v1/forecast");
  target.searchParams.set("latitude",String(lat));
  target.searchParams.set("longitude",String(lon));
  target.searchParams.set("hourly",HOURLY);
  target.searchParams.set("forecast_days","7");
  target.searchParams.set("timezone","UTC");
  target.searchParams.set("models",modelId);
  target.searchParams.set("apikey",env.OPEN_METEO_API_KEY);
  try {
   const response=await fetch(target,{headers:{"accept":"application/json"}});
   if(!response.ok) return reply({error:"Upstream model provider returned "+response.status},502);
   const data=await response.json();
   return reply({model,modelId,provider:"Open-Meteo model interface",retrievedAt:new Date().toISOString(),attribution:"Forecast model data provided via Open-Meteo. Model source: "+({gfs:"NOAA/NCEP GFS",ecmwf:"ECMWF IFS",ukmo_global:"UK Met Office Global 10 km",ukmo_uk:"UK Met Office UK 2 km"}[model]),data});
  } catch(e) { return reply({error:"Unable to retrieve model data"},502); }
 }
};