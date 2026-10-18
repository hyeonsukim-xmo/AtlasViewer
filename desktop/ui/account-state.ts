import {useEffect,useState} from 'react';
import {unwrap,type AccountState} from './imaging';
export function useAccountState(){
  const [state,setState]=useState<AccountState>();
  useEffect(()=>{let alive=true;const off=window.exmoDesktop.onAccountChanged(value=>{if(alive)setState(value);});
    void window.exmoDesktop.accountStatus().then(unwrap).then(value=>{if(alive)setState(value);}).catch(()=>{});
    return()=>{alive=false;off();};},[]);
  return state;
}
