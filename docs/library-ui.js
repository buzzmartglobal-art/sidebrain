/* Static-host bridge: the authenticated Library UI is served by the current Sidebrain endpoint. */
(()=>{let b='';try{b=localStorage.getItem('sb_base')||''}catch(_){}if(!b||b===location.origin)return;const s=document.createElement('script');s.src=b.replace(/\/+$/,'')+'/library-ui.js';document.head.appendChild(s)})();
