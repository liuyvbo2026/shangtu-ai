// Synthetic plan used to test the production contract; no visual-quality evidence.
export function designFixture(output){
 const layouts=['主体展示','图标卡片','局部放大','分区拼版','人物场景','环境场景','多视角排版'];
 const roles=['商品识别','特征说明','细节证据','细节证据','使用情境','使用情境','多角度补充'];
 const questions=['整体外观是什么样？','有哪些可见外观特征？','表面细节怎样呈现？','不同区域怎样连接？','如何融入办公日常？','如何融入窗边环境？','其他参考视角是什么样？'];
 output.images.forEach((x,i)=>{
  const white=x.type==='white',scene=x.type==='scene';
  x.copy.forEach(c=>c.text=x.purpose);
  x.composition.layout=white?'主体展示':layouts[i%7];
  const d=x.design={role:white?'商品识别':scene?'使用情境':roles[i%7],question:questions[i%7],focusSourceIds:['o1'],
   subjectMode:white?'完整主体':i===6?'同品多视角':'完整主体',subjectBox:[.45,.18,.5,.75],
   scene:{kind:scene?(i%2?'环境氛围':'人物互动'):'无',setting:scene?(i%2?'窗边桌面':'办公桌'):'',activity:scene?(i%2?'以侧光和局部布景呈现轮廓':'人物自然握持，保持原有结构') :''},elements:[]};
  if(!white){
   d.elements.push({kind:'标题',copyIndex:0,sourceIds:['o1'],box:[.05,.07,.35,.1]});
   if(x.composition.layout==='图标卡片'){
    x.copy.push(...['蓝色外观','清晰轮廓','侧面线条'].map(text=>({text,sourceIds:['o1']})));
    for(let j=1;j<4;j++)d.elements.push({kind:'图标卡片',copyIndex:j,sourceIds:['o1'],box:[.05,.18+j*.16,.3,.13]});
   }
   if(x.composition.layout==='局部放大')d.elements.push({kind:'局部放大',copyIndex:-1,sourceIds:['o1'],box:[.05,.4,.3,.3]});
  }
 });
 return output;
}
