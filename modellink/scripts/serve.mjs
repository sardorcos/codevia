import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {join,extname,resolve,sep} from 'node:path';
const root=resolve(new URL('../',import.meta.url).pathname);const port=Number(process.env.PORT||4173);
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{
 const url=new URL(req.url||'/',`http://${req.headers.host}`);
 let path=resolve(root,'.'+decodeURI(url.pathname));
 if(!path.startsWith(root+sep)&&path!==root){res.writeHead(403);res.end('Forbidden');return;}
 try{const st=await stat(path);if(st.isDirectory())path=join(path,'index.html');const content=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(content);}catch{res.writeHead(404);res.end('Not found');}
});
server.listen(port,()=>console.log(`ModelLink: http://127.0.0.1:${port}`));
