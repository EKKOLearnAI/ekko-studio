import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
// Build with STUDIO_BASE_PATH=/com.hermeswebui.studio/ first.
// This mock portal rejects root-path escapes; not a TNAS nginx/auth acceptance test.
const prefix='/com.hermeswebui.studio'
const root=fileURLToPath(new URL('../dist/client/', import.meta.url))
const seen=[]
const types={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.json':'application/json'}
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname; seen.push(path)
 if(!path.startsWith(prefix+'/')){res.writeHead(404);res.end('outside prefix');return}
 const local=path.slice(prefix.length)
 if(local==='/api/auth/status'){res.setHeader('content-type','application/json');res.end('{"hasPasswordLogin":true,"hasUsers":true}');return}
 if(local==='/api/auth/login'){res.writeHead(401,{'content-type':'application/json'});res.end('{"error":"Invalid username or password"}');return}
 const file=join(root,local==='/'?'index.html':local)
 if(!existsSync(file)){res.writeHead(404);res.end();return}
 res.setHeader('content-type',types[extname(file)]||'application/octet-stream');res.end(readFileSync(file))
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const port=server.address().port
const browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
try{
 await page.goto(`http://127.0.0.1:${port}${prefix}/`)
 await page.getByPlaceholder('Username').fill('smoke')
 await page.getByPlaceholder('Password').fill('invalid')
 await page.getByRole('button',{name:'Login',exact:true}).click()
 await page.getByText('Invalid username or password').waitFor()
 const outside=seen.filter(p=>!p.startsWith(prefix+'/'))
 if(outside.length||errors.length)throw new Error(JSON.stringify({outside,errors}))
 console.log(JSON.stringify({passed:true,requests:seen.length,auth:seen.filter(x=>x.includes('/api/'))}))
}finally{await browser.close();await new Promise(r=>server.close(r))}
