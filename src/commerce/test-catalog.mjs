import { CATEGORIES } from './domain.mjs';
const nouns=['Pendant','Hair Clip','Chain','Ear Rings','Scrunchie','Bag','Phone Charm','Key Chain','Bracelet','Gift Set'];
export function buildTestCatalog(){
  return {
    marker:'MYBSHOPPY_ISOLATED_TEST_100_V1',categories:CATEGORIES.map(c=>({...c})),
    subcategories:CATEGORIES.map(c=>({category_id:c.id,name:'TEST Essentials',slug:'test-essentials',sort_order:0,is_active:true,image_ref:'test:'+c.id})),
    images:CATEGORIES.map((c,i)=>({ref:'test:'+c.id,width:400,height:400,background:{r:180+i*5,g:110+i*7,b:90+i*9}})),
    products:CATEGORIES.flatMap((c,ci)=>Array.from({length:10},(_,i)=>({
      slug:`test-mbs-${c.id}-${String(i+1).padStart(2,'0')}`,title:`TEST ${c.name} ${nouns[ci]} ${String(i+1).padStart(2,'0')}`,
      sku:`TEST-MBS-C${String(ci+1).padStart(2,'0')}-P${String(i+1).padStart(2,'0')}`,
      category_id:c.id,subcategory_ref:c.id+':test-essentials',image_ref:'test:'+c.id,
      sale_price:100+ci*20+i*5,mrp:150+ci*20+i*5,quantity:20+i,
      variants:['Test Coral','Test Slate'],badges:i===0?['Featured']:[],description:'Clearly labelled synthetic test product. Not a production listing.',material:'Test alloy',rating:0,reviews_count:0,
    }))),
  };
}
