
/* ==========================================
   LEO APP - MOTOR OCR
   Lectura automática de cronogramas
   ========================================== */

window.LeoReader = (function(){

"use strict";

const MONTHS = {
  enero:0, febrero:1, marzo:2, abril:3,
  mayo:4, junio:5, julio:6, agosto:7,
  septiembre:8, setiembre:8,
  octubre:9, noviembre:10, diciembre:11
};

const MONTH_NAMES = Object.keys(MONTHS);

function clean(text){
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/\s+/g," ")
    .trim();
}

function report(progress,value,text){
  if(progress) progress(value,text);
}

async function recognize(file,progress){
  if(!window.Tesseract){
    throw new Error("No se cargó el motor OCR.");
  }

  const worker = await Tesseract.createWorker("spa",1,{
    logger: message=>{
      if(message.status==="recognizing text"){
        report(
          progress,
          Math.round(message.progress*75),
          "Reconociendo texto de la imagen..."
        );
      }
    }
  });

  try{
    const result=await worker.recognize(file);
    return result.data;
  }finally{
    await worker.terminate();
  }
}

function getWords(data){
  return (data.words || [])
    .filter(w=>w.text && w.bbox)
    .map(w=>({
      text:clean(w.text),
      x:(w.bbox.x0+w.bbox.x1)/2,
      y:(w.bbox.y0+w.bbox.y1)/2,
      x0:w.bbox.x0,
      x1:w.bbox.x1,
      y0:w.bbox.y0,
      y1:w.bbox.y1,
      confidence:w.confidence || 0
    }));
}

function clusterRows(words){
  const sorted=words.slice().sort((a,b)=>a.y-b.y);
  const rows=[];

  sorted.forEach(word=>{
    let row=rows.find(r=>
      Math.abs(r.y-word.y)<Math.max(8,(word.y1-word.y0)*0.65)
    );

    if(!row){
      row={y:word.y,words:[]};
      rows.push(row);
    }

    row.words.push(word);
    row.y=row.words.reduce((s,w)=>s+w.y,0)/row.words.length;
  });

  rows.forEach(r=>r.words.sort((a,b)=>a.x-b.x));
  return rows.sort((a,b)=>a.y-b.y);
}

function monthFromText(text){
  const value=clean(text).toLowerCase();

  for(const name of MONTH_NAMES){
    if(value.includes(name)){
      return MONTHS[name];
    }
  }

  return null;
}

function findDateRow(rows){
  let best=null;
  let bestScore=0;

  rows.forEach((row,index)=>{
    const found=row.words.filter(w=>{
      const value=w.text.replace(/[Oo]/g,"0");
      return /^\d{1,2}$/.test(value) &&
        Number(value)>=1 && Number(value)<=31;
    });

    const score=found.length;

    if(score>=3 && score>bestScore){
      bestScore=score;
      best={index,row,words:found};
    }
  });

  return best;
}

function detectMonths(rows,dateRow){
  const monthWords=[];

  rows.forEach(row=>{
    if(Math.abs(row.y-dateRow.row.y)<35) return;

    row.words.forEach(w=>{
      const month=monthFromText(w.text);
      if(month!==null){
        monthWords.push({
          month,
          x:w.x,
          year:(w.text.match(/20\d{2}/)||[])[0]
        });
      }
    });
  });

  return monthWords.sort((a,b)=>a.x-b.x);
}

function inferDateColumns(dateRow,months){
  const dateWords=dateRow.words
    .map(w=>{
      const day=Number(w.text.replace(/[Oo]/g,"0"));
      return {...w,day};
    })
    .filter(w=>w.day>=1 && w.day<=31)
    .sort((a,b)=>a.x-b.x);

  if(!dateWords.length) return [];

  const now=new Date();
  let year=now.getFullYear();
  let month=now.getMonth();

  // Si hay meses escritos en el encabezado,
  // usar el mes más cercano a cada columna.
  const result=[];
  let previousDay=null;
  let previousMonth=null;

  dateWords.forEach(word=>{
    let nearest=null;
    let distance=Infinity;

    months.forEach(m=>{
      const d=Math.abs(m.x-word.x);
      if(d<distance){
        nearest=m;
        distance=d;
      }
    });

    let currentMonth=nearest ? nearest.month : null;

    if(currentMonth===null){
      if(previousDay!==null && word.day<previousDay){
        month=(month+1)%12;
        if(month===0) year++;
      }

      currentMonth=month;
    }else{
      if(previousMonth!==null && currentMonth<previousMonth){
        if(previousMonth===11 && currentMonth===0){
          year++;
        }
      }

      month=currentMonth;
    }

    let currentYear=nearest && nearest.year
      ? Number(nearest.year)
      : year;

    result.push({
      day:word.day,
      month:currentMonth,
      year:currentYear,
      x:word.x
    });

    previousDay=word.day;
    previousMonth=currentMonth;
  });

  return result;
}

function parseHours(text){
  const value=clean(text)
    .toLowerCase()
    .replace(/hs?/g,"")
    .replace(/[–—]/g,"-")
    .replace(/\s/g,"");

  const match=value.match(
    /(?:^|[^0-9])([0-2]?\d)-([0-2]?\d)(?:$|[^0-9])/
  );

  if(match){
    const start=Number(match[1]);
    const end=Number(match[2]);

    if(start<=23 && end<=23){
      return {
        hours:start+"-"+end,
        status:"pendiente"
      };
    }
  }

  // No inferir turnos a partir de una letra o un número.
  return null;
}

function findNames(rows,dateRow,columns){
  const candidates=[];

  rows.forEach(row=>{
    if(row.y<=dateRow.row.y) return;

    const leftWords=row.words.filter(w=>
      w.x<columns[0].x-5
    );

    if(!leftWords.length) return;

    const name=leftWords.map(w=>w.text).join(" ");
    const normalized=clean(name).toLowerCase();

    if(name.length<4) return;

    if(/^(feriado|vacaciones|nuevos equipos|nombre|personal)/i.test(normalized)){
      return;
    }

    if(!/[a-z]/i.test(name)) return;

    candidates.push({
      name:clean(name),
      y:row.y,
      row
    });
  });

  return candidates;
}

function dateString(date){
  return date.year+"-"+
    String(date.month+1).padStart(2,"0")+"-"+
    String(date.day).padStart(2,"0");
}

function extractCandidates(rows,dateRow,columns){
  const people=findNames(rows,dateRow,columns);
  const candidates=[];

  people.forEach(person=>{
    columns.forEach((column,index)=>{
      const next=columns[index+1];

      const cellWords=person.row.words.filter(w=>
        w.x>=column.x-5 &&
        (!next || w.x<next.x-5)
      );

      if(!cellWords.length) return;

      const raw=cellWords.map(w=>w.text).join(" ");
      const parsed=parseHours(raw);

      if(!parsed) return;

      candidates.push({
        person:person.name,
        date:dateString(column),
        day:column.day,
        month:column.month+1,
        year:column.year,
        raw:raw,
        hours:parsed.hours,
        confidence:Math.round(
          cellWords.reduce((s,w)=>s+w.confidence,0)/
          cellWords.length
        ),
        status:"pendiente"
      });
    });
  });

  return candidates;
}

async function scan(file,progress){
  report(progress,0,"Preparando imagen...");

  const data=await recognize(file,progress);

  report(progress,80,"Analizando fechas y encabezados...");

  const words=getWords(data);
  const rows=clusterRows(words);

  if(!rows.length){
    throw new Error("No se pudo reconocer texto en la imagen.");
  }

  const dateRow=findDateRow(rows);

  if(!dateRow){
    throw new Error(
      "No se encontraron suficientes números de días. Probá una foto más nítida y completa."
    );
  }

  report(progress,86,"Reconociendo meses...");

  const months=detectMonths(rows,dateRow);
  const columns=inferDateColumns(dateRow,months);

  if(!columns.length){
    throw new Error("No se pudieron interpretar las fechas.");
  }

  report(progress,92,"Buscando nombres y horarios...");

  const candidates=extractCandidates(
    rows,
    dateRow,
    columns
  );

  report(
    progress,
    100,
    "Lectura terminada: "+candidates.length+
    " horarios encontrados."
  );

  return {
    candidates:candidates,
    dates:columns,
    months:months,
    text:data.text || ""
  };
}

return {scan:scan};

})();
