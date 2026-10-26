const Module=require('node:module');const load=Module._load;Module._load=function(id,...rest){if(id==='electron')return {app:{getLocale:()=> 'en'}};return load.call(this,id,...rest)}
// Real processes, no model/credentials/update downloads. PROBE_DIST points to
// the compiled production Desktop modules under test.
const {join}=require('node:path')
const {InstallationCoordinator}=require(join(process.env.PROBE_DIST,'installation-coordinator.js'))
const {BrowserProfileLeases}=require(join(process.env.PROBE_DIST,'browser/browser-profile-lease.js'))
let coordinator
const releases=[]
const send=value=>console.log(JSON.stringify(value))
async function run() {
 if(process.env.PROBE_DEVICE){
  const {ownDeviceWindow}=require(join(process.env.PROBE_DIST,'device-window-owner.js'))
  const release=await ownDeviceWindow(process.env.PROBE_DEVICE,()=>send({event:'focused'}))
  if(!release){send({event:'reused'});return}
  releases.push(release);send({event:'device-owned'})
 }else if(process.env.PROBE_PROFILE){
  const leases=new BrowserProfileLeases(release=>releases.push(release))
  await leases.acquire(process.env.PROBE_PROFILE);send({event:'profile-owned'})
 }else{
  coordinator=new InstallationCoordinator(process.execPath,process.env.PROBE_REGISTRY)
  coordinator.register('1.0.0');send({event:'registered'})
 }
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  try{
   if(line==='transaction'){
    const {DatabaseSync}=require('node:sqlite')
    const registry=join(process.env.PROBE_REGISTRY,require('node:fs').readdirSync(process.env.PROBE_REGISTRY)[0],'coordination.sqlite')
    const db=new DatabaseSync(registry)
    db.exec('BEGIN IMMEDIATE')
    db.prepare('INSERT INTO installation VALUES(1,?,?)').run(process.pid,'2.0.0')
    releases.push(()=>{db.exec('ROLLBACK');db.close()});send({event:'transaction-open'})
   }
   if(line==='install'){const cancel=coordinator.beginInstall('2.0.0');releases.push(cancel);send({event:'install-held'})}
   if(line==='quit'){releases.splice(0).reverse().forEach(release=>release());coordinator?.release();process.exit(0)}
  }catch(error){send({event:'blocked',message:error.message})}
 })
}
run().catch(error=>{send({event:'blocked',message:error.message});process.exitCode=2})
