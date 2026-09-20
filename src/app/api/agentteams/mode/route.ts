// GET /api/agentteams/mode - Detect deployment mode from filesystem / env.
// Returns 'embedded' or 'k8s'. This is used as a fallback when the Controller
// API is unreachable at startup.
//
// F7: also reports `authMode` ('stateless' | 'stateful'). This endpoint is
// public (in the middleware PUBLIC_PATHS) so the pre-login page can pick the
// right login flow. The payload discloses no secrets — only which credential
// model this deployment runs. In stateless mode it additionally carries the
// server-side Matrix homeserver candidates (the address is a deploy constant;
// the pre-login page needs it to prefill first-time logins — NEXT_PUBLIC_*
// client inlining cannot reach container runtime env).
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { isStatelessAuthMode } from '@/lib/static-mode';
import { serverHomeserverCandidates } from '@/lib/static-identity';

function isInKubernetesPod(): boolean {
  try {
    return fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token');
  } catch {
    return false;
  }
}

function payload(mode: string, source: string) {
  const stateless = isStatelessAuthMode();
  return NextResponse.json({
    mode,
    source,
    authMode: stateless ? 'stateless' : 'stateful',
    ...(stateless ? { defaultHomeservers: serverHomeserverCandidates() } : {}),
  });
}

export async function GET() {
  // Dashboard-specific override takes precedence.
  const envMode = process.env.AGENTTEAMS_DEPLOYMENT_MODE;
  if (envMode === 'embedded' || envMode === 'k8s') {
    return payload(envMode, 'env');
  }

  // Upstream AgentTeams convention (controller config.go): AGENTTEAMS_KUBE_MODE
  // is 'embedded' (default, single docker container) or 'incluster' (k8s/helm).
  const kubeMode = process.env.AGENTTEAMS_KUBE_MODE;
  if (kubeMode === 'incluster' || kubeMode === 'k8s') {
    return payload('k8s', 'env');
  }
  if (kubeMode === 'embedded') {
    return payload('embedded', 'env');
  }

  const mode = isInKubernetesPod() ? 'k8s' : 'embedded';
  return payload(mode, 'filesystem');
}
