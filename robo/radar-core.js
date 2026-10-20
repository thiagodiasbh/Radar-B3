/*CORE-BEGIN*/
/* Radar B3 — núcleo de cálculo compartilhado (HTML + robô).
   Fonte única dos indicadores e do termômetro de compra.
   Se mudar algo aqui, a mesma cópia precisa ir para o index.html (entre CORE-BEGIN/CORE-END). */
(function(root){
  const CORE_VERSION='core-2026.10.1';
  const TUNE_KEYS=['disc','rsi','mm200','virada','vol'];
  const TUNE_DEF={w:{disc:25,rsi:25,mm200:20,virada:15,vol:15},fav:70,neu:45};

  // média simples dos últimos n valores
  function sma(cl,n){
    if(!cl||cl.length<n)return null;
    let s=0;for(let i=cl.length-n;i<cl.length;i++)s+=cl[i];
    return s/n;
  }
  // RSI de Wilder (o mesmo de TradingView/Profit)
  function rsi(cl,n){
    n=n||14;
    if(!cl||cl.length<n+1)return null;
    let g=0,l=0;
    for(let i=1;i<=n;i++){const d=cl[i]-cl[i-1];if(d>0)g+=d;else l-=d}
    let ag=g/n,al=l/n;
    for(let i=n+1;i<cl.length;i++){
      const d=cl[i]-cl[i-1];
      ag=(ag*(n-1)+(d>0?d:0))/n; al=(al*(n-1)+(d<0?-d:0))/n;
    }
    if(al===0)return 100;
    return 100-100/(1+ag/al);
  }
  // volatilidade anualizada (%) dos retornos log dos últimos n pregões
  function vol(cl,n){
    n=n||21;
    if(!cl||cl.length<n+1)return null;
    const r=[];
    for(let i=cl.length-n;i<cl.length;i++)r.push(Math.log(cl[i]/cl[i-1]));
    const m=r.reduce((s,v)=>s+v,0)/r.length;
    const sd=Math.sqrt(r.reduce((s,v)=>s+(v-m)*(v-m),0)/(r.length-1));
    return sd*Math.sqrt(252)*100;
  }
  // ATR de Wilder sobre barras {h,l,c}; null se faltar máxima/mínima
  function atr(bars,n){
    n=n||14;
    if(!bars||bars.length<n+1)return null;
    const tr=[];
    for(let i=1;i<bars.length;i++){
      const b=bars[i],p=bars[i-1];
      if(!(b.h>0&&b.l>0&&p.c>0))return null;
      tr.push(Math.max(b.h-b.l,Math.abs(b.h-p.c),Math.abs(b.l-p.c)));
    }
    let a=tr.slice(0,n).reduce((s,v)=>s+v,0)/n;
    for(let i=n;i<tr.length;i++)a=(a*(n-1)+tr[i])/n;
    return a;
  }
  // retorno % em n pregões
  function retN(cl,n){
    if(!cl||cl.length<=n)return null;
    return (cl[cl.length-1]/cl[cl.length-1-n]-1)*100;
  }
  // força relativa: retorno do ativo menos retorno do índice no mesmo período (pontos %)
  function relStrength(cl,bench,n){
    const a=retN(cl,n),b=retN(bench,n);
    return a==null||b==null?null:a-b;
  }
  // indicadores a partir dos fechamentos (mesma régua do HTML)
  function indicators(closes,extra){
    extra=extra||{};
    const px=extra.px!=null?extra.px:closes[closes.length-1];
    return {
      px,
      mm21:sma(closes,21),mm50:sma(closes,50),mm200:sma(closes,200),
      rsi:rsi(closes,14),vol:vol(closes,21),
      hi52:extra.hi52||Math.max(...closes),
      lo52:extra.lo52||Math.min(...closes)
    };
  }
  function normTune(t){
    t=t||{};
    const w=Object.assign({},TUNE_DEF.w,t.w||{});
    return {w,fav:(t.fav!=null?+t.fav:TUNE_DEF.fav),neu:(t.neu!=null?+t.neu:TUNE_DEF.neu)};
  }
  // termômetro de compra 0–100 (critérios abertos, pesos calibráveis)
  function buyScore(ind,tune){
    const it=[];let p,why;
    const disc=ind.hi52?100*(ind.hi52-ind.px)/ind.hi52:null;
    if(disc==null){p=0;why='topo 52s indisponível'}
    else if(disc>=30){p=25;why=disc.toFixed(0)+'% abaixo do topo — desconto grande'}
    else if(disc>=20){p=18;why=disc.toFixed(0)+'% abaixo do topo'}
    else if(disc>=10){p=10;why=disc.toFixed(0)+'% abaixo do topo — desconto moderado'}
    else{p=3;why='a '+disc.toFixed(0)+'% do topo — pouco desconto'}
    it.push({k:'disc',n:'Desconto vs. topo 52 semanas',p,max:25,why});
    const r=ind.rsi;
    if(r==null){p=0;why='RSI indisponível'}
    else if(r<=30){p=25;why='RSI '+r.toFixed(0)+' — sobrevendido'}
    else if(r<=40){p=18;why='RSI '+r.toFixed(0)+' — pressão vendedora forte'}
    else if(r<=50){p=12;why='RSI '+r.toFixed(0)+' — levemente fraco'}
    else if(r<=60){p=6;why='RSI '+r.toFixed(0)+' — neutro'}
    else{p=0;why='RSI '+r.toFixed(0)+' — esticado para cima'}
    it.push({k:'rsi',n:'RSI 14 (momentum)',p,max:25,why});
    if(ind.mm200==null){p=0;why='MM200 indisponível (histórico ainda curto)'}
    else{
      const d=100*(ind.px-ind.mm200)/ind.mm200;
      if(d<-15){p=12;why=Math.abs(d).toFixed(0)+'% abaixo da MM200 — barato, mas queda forte (risco de faca caindo)'}
      else if(d<0){p=20;why=Math.abs(d).toFixed(0)+'% abaixo da MM200 — zona de acumulação'}
      else if(d<=10){p=10;why=d.toFixed(0)+'% acima da MM200 — tendência saudável, preço justo'}
      else{p=4;why=d.toFixed(0)+'% acima da MM200 — esticado da média longa'}
    }
    it.push({k:'mm200',n:'Preço vs. MM200',p,max:20,why});
    if(ind.mm21==null||ind.mm50==null){p=0;why='médias curtas indisponíveis'}
    else if(ind.mm21>ind.mm50){p=15;why='MM21 acima da MM50 — curto prazo virou para cima'}
    else if(ind.mm21>=ind.mm50*0.97){p=8;why='MM21 se aproximando da MM50 — possível virada'}
    else{p=0;why='MM21 bem abaixo da MM50 — curto prazo ainda caindo'}
    it.push({k:'virada',n:'Virada de tendência (MM21 × MM50)',p,max:15,why});
    const v=ind.vol;
    if(v==null){p=0;why='volatilidade indisponível'}
    else if(v<=25){p=15;why='vol. anualizada '+v.toFixed(0)+'% — comportada'}
    else if(v<=40){p=10;why='vol. anualizada '+v.toFixed(0)+'% — moderada'}
    else if(v<=60){p=5;why='vol. anualizada '+v.toFixed(0)+'% — alta'}
    else{p=0;why='vol. anualizada '+v.toFixed(0)+'% — muito alta, entrada arriscada'}
    it.push({k:'vol',n:'Volatilidade (21 dias)',p,max:15,why});
    const T=normTune(tune);
    const sw=TUNE_KEYS.reduce((s,k)=>s+Math.max(0,+T.w[k]||0),0)||100;
    it.forEach((x,i)=>{
      const wk=Math.max(0,+T.w[TUNE_KEYS[i]]||0),f=100/sw;
      x.p=Math.round(x.p/x.max*wk*f);
      x.max=Math.round(wk*f);
    });
    return {total:it.reduce((s,x)=>s+x.p,0),items:it};
  }
  function scoreLabel(t,tune){
    const T=normTune(tune);
    if(t>=T.fav)return{key:'fav',txt:'CONDIÇÕES FAVORÁVEIS'};
    if(t>=T.neu)return{key:'neu',txt:'NEUTRO — AGUARDAR'};
    return{key:'des',txt:'DESFAVORÁVEL'};
  }
  // filtros de risco (não entram no score; servem de aviso)
  function riskFlags(ind,nBars){
    const f=[];
    if(ind.mm200!=null&&ind.px<ind.mm200)f.push('preço abaixo da MM200');
    if(ind.mm21!=null&&ind.mm50!=null&&ind.mm21<ind.mm50)f.push('MM21 abaixo da MM50');
    if(ind.vol!=null&&ind.vol>60)f.push('volatilidade acima de 60% a.a.');
    if(nBars!=null&&nBars<200)f.push('histórico com '+nBars+' pregões (MM200 exige 200)');
    const disc=ind.hi52?100*(ind.hi52-ind.px)/ind.hi52:null;
    if(disc!=null&&disc>=25&&ind.mm200!=null&&ind.px<ind.mm200)f.push('desconto alto em tendência de baixa — risco de faca caindo');
    return f;
  }
  const api={CORE_VERSION,TUNE_KEYS,TUNE_DEF,sma,rsi,vol,atr,retN,relStrength,indicators,normTune,buyScore,scoreLabel,riskFlags};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.RadarCore=api;
})(typeof window!=='undefined'?window:globalThis);
/*CORE-END*/
