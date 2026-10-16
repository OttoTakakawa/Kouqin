import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as fs from 'node:fs/promises';
import {validateScore} from './public/model.mjs';
const base=path.dirname(fileURLToPath(import.meta.url));
const library=process.env.HARMONICA_LIBRARY || 'F:\\大图书馆WIn\\BaiduSyncdisk\\软件笔记\\D_口琴与乐理\\01_乐谱';
const vault=process.env.HARMONICA_VAULT || path.resolve(library,'../..');
const data=process.env.HARMONICA_DATA || path.join(base,'data');
await fs.mkdir(data,{recursive:true});
async function walk(dir,ext){let result=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())continue;const p=path.join(dir,e.name);if(e.isDirectory())result.push(...await walk(p,ext));else if(ext.test(e.name))result.push(p);}return result;}
let originals=[];let libraryError='';
try{originals=(await walk(library,/\.md$/i)).map((p,i)=>({id:String(i),title:path.basename(p,'.md'),category:path.relative(library,path.dirname(p)),path:p}));}catch(e){libraryError='乐谱目录无法读取，请检查 HARMONICA_LIBRARY 设置。';}
let imageMap;
async function images(){if(!imageMap){imageMap=walk(vault,/\.(png|jpe?g|webp|gif)$/i).then(files=>{const map=new Map();for(const p of files){const name=path.basename(p);if(!map.has(name))map.set(name,[]);map.get(name).push(p);}return map;}).catch(e=>{imageMap=null;throw e;});}return imageMap;}
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.mjs':'text/javascript','.js':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://127.0.0.1');const route=url.pathname;
 if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`)return json(res,403,{error:'不允许跨站访问'});
 if(!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host||''))return json(res,403,{error:'仅允许本机访问'});
 if(route==='/api/health')return json(res,200,{ok:true,version:1,libraryCount:originals.length,libraryError});
 if(route==='/api/library')return json(res,200,{items:originals.map(({path,...x})=>x),error:libraryError});
 if(route==='/api/original'){
 const item=originals.find(x=>x.id===url.searchParams.get('id'));if(!item)return json(res,404,{error:'乐谱不存在'});
 const text=await fs.readFile(item.path,'utf8');const refs=[...text.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(m=>m[1]);
 return json(res,200,{text,images:refs.map((_,i)=>`/api/image?id=${item.id}&n=${i}`)});
 }
 if(route==='/api/image'){
 const item=originals.find(x=>x.id===url.searchParams.get('id'));if(!item)return json(res,404,{error:'不存在'});
 const text=await fs.readFile(item.path,'utf8');const refs=[...text.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(m=>m[1]);
 const ref=refs[Number(url.searchParams.get('n'))];if(!ref)return json(res,404,{error:'图片不存在'});
 const matches=(await images()).get(path.basename(ref))||[];if(matches.length!==1)return json(res,404,{error:'图片缺失或重名，无法唯一定位'});
 res.writeHead(200,{'Content-Type':mime[path.extname(matches[0]).toLowerCase()]||'application/octet-stream'});return res.end(await fs.readFile(matches[0]));
 }
 if(route==='/api/scores' && req.method==='GET'){const files=await walk(data,/\.json$/);return json(res,200,await Promise.all(files.map(async p=>JSON.parse(await fs.readFile(p,'utf8')))));}
 if(route==='/api/scores' && req.method==='POST'){
 let body='';for await(const chunk of req){body+=chunk;if(body.length>2e6)return json(res,413,{error:'文件过大'});}
 const score=JSON.parse(body);validateScore(score);const target=path.join(data,score.id+'.json');const temp=target+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(score,null,2));await fs.rename(temp,target);return json(res,200,{ok:true});
 }
 if(req.method!=='GET')return json(res,405,{error:'不支持的操作'});
const allowed=new Set(['index.html','model.mjs']);const name=route==='/'?'index.html':route.slice(1);if(!allowed.has(name))return json(res,404,{error:'不存在'});
 res.writeHead(200,{'Content-Type':mime[path.extname(name)],'X-Content-Type-Options':'nosniff'});res.end(await fs.readFile(path.join(base,'public',name)));
 }catch(e){json(res,400,{error:e.message});}});
server.listen(process.env.PORT===undefined?4317:Number(process.env.PORT),'127.0.0.1',()=>console.log('Harmonica Studio: http://127.0.0.1:'+server.address().port));
