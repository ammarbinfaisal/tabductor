#!/usr/bin/env python3
"""Install pinned platform controllers after the foundation is ready."""
import json
import os
import subprocess
from pathlib import Path

def run(*args, **kwargs): return subprocess.check_output(list(args), text=True, **kwargs)
d = json.loads(run('python3','scripts/aws/terraform.py','-chdir=infra/aws/foundation','output','-json','deployment'))
root=Path('.tabductor-aws').resolve()
os.environ['KUBECONFIG']=str(root/'kubeconfig')
run('aws','eks','update-kubeconfig','--name',d['cluster_name'],'--region',d['region'],'--kubeconfig',os.environ['KUBECONFIG'])
def apply(document): run('kubectl','apply','-f','-',input=json.dumps(document))
apply({'apiVersion':'v1','kind':'Namespace','metadata':{'name':'tabductor-staging'}})
# Strict VPC CNI mode requires explicit policy for system/controller traffic too.
apply({'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':'platform-system','namespace':'kube-system'},
       'spec':{'podSelector':{},'policyTypes':['Ingress','Egress'],'ingress':[{}],'egress':[{}]}})
run('helm','upgrade','--install','karpenter','oci://public.ecr.aws/karpenter/karpenter','--version','1.14.1','--namespace','kube-system',
    '--set','settings.clusterName='+d['cluster_name'],'--set','settings.clusterEndpoint='+d['cluster_endpoint'],
    '--set','settings.interruptionQueue='+d['karpenter_queue'],'--set','nodeSelector.tabductor\\.io/node-role=control',
    '--set','replicas=1','--set','controller.resources.requests.cpu=200m','--set','controller.resources.requests.memory=512Mi',
    '--wait','--timeout','5m')
run('helm','repo','add','eks','https://aws.github.io/eks-charts','--force-update')
run('helm','repo','update','eks')
run('helm','upgrade','--install','aws-load-balancer-controller','eks/aws-load-balancer-controller','--version','3.5.0','--namespace','kube-system',
    '--set','clusterName='+d['cluster_name'],'--set','region='+d['region'],'--set','vpcId='+d['vpc_id'],
    '--set','serviceAccount.name=aws-load-balancer-controller','--set','nodeSelector.tabductor\\.io/node-role=control','--wait','--timeout','5m')
ami=run('aws','ssm','get-parameter','--name','/aws/service/eks/optimized-ami/1.34/amazon-linux-2023/x86_64/standard/recommended/image_id',
        '--region',d['region'],'--query','Parameter.Value','--output','text').strip()
apply({'apiVersion':'karpenter.k8s.aws/v1','kind':'EC2NodeClass','metadata':{'name':'tabductor-browser'},'spec':{
    'role':d['browser_node_role'],'amiFamily':'AL2023','amiSelectorTerms':[{'id':ami}],
    'subnetSelectorTerms':[{'tags':{'karpenter.sh/discovery':d['cluster_name']}}],
    'securityGroupSelectorTerms':[{'tags':{'karpenter.sh/discovery':d['cluster_name']}}],
    'metadataOptions':{'httpEndpoint':'enabled','httpTokens':'required','httpPutResponseHopLimit':1},
    'tags':{'Project':'tabductor','Environment':'staging','ManagedBy':'karpenter'},
    'blockDeviceMappings':[{'deviceName':'/dev/xvda','ebs':{'volumeSize':'80Gi','volumeType':'gp3','encrypted':True,'deleteOnTermination':True}}]
}})
apply({'apiVersion':'karpenter.sh/v1','kind':'NodePool','metadata':{'name':'tabductor-browser'},'spec':{
    'template':{'metadata':{'labels':{'tabductor.io/node-role':'browser'}},'spec':{
        'nodeClassRef':{'group':'karpenter.k8s.aws','kind':'EC2NodeClass','name':'tabductor-browser'},
        'taints':[{'key':'tabductor.io/browser','value':'true','effect':'NoSchedule'}],
        'requirements':[{'key':'karpenter.sh/capacity-type','operator':'In','values':['on-demand']},
          {'key':'kubernetes.io/arch','operator':'In','values':['amd64']},
          {'key':'karpenter.k8s.aws/instance-family','operator':'In','values':['m6i','m7i','r6i','r7i']},
          {'key':'karpenter.k8s.aws/instance-size','operator':'In','values':['xlarge','2xlarge']}],
        'expireAfter':'Never'}},
    'limits':{'cpu':'64','memory':'128Gi'},
    'disruption':{'consolidationPolicy':'WhenEmpty','consolidateAfter':'180s','budgets':[{'nodes':'1'}]}
}})
print('Pinned platform controllers and bounded On-Demand browser NodePool installed.')
