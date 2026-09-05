import puppeteer from 'puppeteer';
const b = await puppeteer.launch({ args:['--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage();
await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{ if(m.type()==='error') errs.push('console: '+m.text()); });

await p.goto('http://localhost:3000/#/', { waitUntil:'networkidle2', timeout:60000 });
await new Promise(r=>setTimeout(r,2500));
await p.screenshot({ path:'/tmp/w1.png', fullPage:true });

// 點「火警」
await p.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('火警'))?.click());
await new Promise(r=>setTimeout(r,2000));
await p.screenshot({ path:'/tmp/w2.png', fullPage:true });

console.log('可見按鈕:', await p.evaluate(()=>[...document.querySelectorAll('button,a')].map(b=>b.textContent.trim().replace(/\s+/g,' ')).filter(t=>t&&t.length<40).slice(0,30)));
console.log('errors:', errs.length?errs:'none');
await b.close();
