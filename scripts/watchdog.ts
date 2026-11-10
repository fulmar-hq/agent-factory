import {watchdogAlert} from '../launcher/alerts';
import {join} from 'node:path';
import {configAt,root} from '../launcher/config';
import {Store} from '../tracking/store';
import {Engine} from '../launcher/engine';
import {checkClaimStall} from '../launcher/watchdog';
const s=new Store(join(root,'controller.sqlite'));
try{console.info(JSON.stringify(checkClaimStall(new Engine(s,await configAt()),Date.now())));watchdogAlert(s,Date.now());}finally{s.close();}
