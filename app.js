
document.querySelectorAll('[data-placeholder]').forEach(a=>{
 a.addEventListener('click',e=>{
   if(a.getAttribute('href')==='#marketplace-link'){
     e.preventDefault();
     alert('Add your exact product/store marketplace URL here before launch.');
   }
 });
});
