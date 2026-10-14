"""Explicit Docker-only fixture acceptance; no external platform is contacted."""
import hashlib
import json
import time
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

settings=json.loads(Path('/config/config.json').read_text())
assert settings['fixturesEnabled'] is True
origin='http://127.0.0.1:8916'

def send(path, value, authorized=True):
 headers={'Content-Type':'application/json'}
 if authorized:headers['Authorization']='Bearer '+settings['serviceKey']
 request=Request(origin+path,json.dumps(value).encode(),headers,method='POST')
 with urlopen(request,timeout=40) as response:return json.load(response)

def packet(operation='preflight', attempt=None):
 return {'version':1,'operation':operation,'platform':'xueqiu','sessionId':settings['sessionId'],'expectedAccountId':'123','jobId':str(uuid.uuid4()),'attemptId':attempt or str(uuid.uuid4()),'contentHash':'a'*64,'revision':1,'ownerToken':str(uuid.uuid4()),'deadline':(datetime.now(timezone.utc)+timedelta(seconds=30)).isoformat().replace('+00:00','Z'),'title':'Isolated source-backed fixture','text':'Original fixture paragraph.','symbols':[{'market':'SH','code':'600000','name':'Owner-reviewed fixture name'}],'assets':[]}

try:send('/request',packet(),False);raise AssertionError('Unauthenticated request accepted')
except HTTPError as error:assert error.code==403
ready=send('/request',packet());assert ready['ready'] is True and ready['accountId']=='123'
wrong=packet();wrong['expectedAccountId']='different';assert send('/request',wrong)['status']=='rejected'
with urlopen(Request(origin+'/fixture/writes',headers={'Authorization':'Bearer '+settings['serviceKey']})) as response:before=json.load(response)['writes']
request=json.loads(Path('/staging/smoke-request.json').read_text());request['deadline']=packet()['deadline']
accepted=send('/request',request);assert accepted['status']=='accepted'
assert send('/request',request)==accepted
changed={**request,'contentHash':'b'*64};assert send('/request',changed)['status']=='unknown'
with urlopen(Request(origin+'/fixture/writes',headers={'Authorization':'Bearer '+settings['serviceKey']})) as response:after=json.load(response)['writes']
assert after-before==1
handoff=send('/session',{'action':'handoff','sessionId':settings['sessionId']});assert handoff['handoff'] is True
assert send('/request',packet())['status']=='rejected'
assert send('/session',{'action':'resume','sessionId':settings['sessionId']})['handoff'] is False
metrics=send('/request',packet('collect_metrics'));assert metrics['views']==0 and metrics['comments'] is None and metrics['source']=='fixture'
# The documented compatibility gate includes more than sixty seconds idle.
time.sleep(61)
assert send('/request',packet())['ready'] is True
closed=send('/session',{'action':'close','sessionId':settings['sessionId']});assert closed['closed'] is True
assert send('/request',packet())['ready'] is True
print(json.dumps({'fixtureOnly':True,'externalPublicPosts':0,'writesForAttempt':1,'duplicateReplayWrites':0,'wrongIdentityRejected':True,'manualHandoffExclusive':True,'missingMetricsRemainNull':True,'idleReconnectSeconds':61,'sessionRestartPassed':True}))
