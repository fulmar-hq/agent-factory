#!/usr/bin/env bun
import {root} from '../launcher/config';
import {executeCodexRenewal} from '../adapters/codex-renewal';
const id=process.argv[2];if(process.argv.length!==3||!id||!/^[a-f0-9]{64}$/.test(id))throw Error('renew-codex requires an existing launcher claim');
const result=await executeCodexRenewal(root,id);console.log(JSON.stringify(result));if(result.state!=='renewed')process.exitCode=1;
