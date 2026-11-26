{{- define "neurouter-core.name" -}}{{ .Values.nameOverride | default "neurouter-core" | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "neurouter-core.fullname" -}}
{{- if .Values.fullnameOverride -}}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else -}}{{- $n := include "neurouter-core.name" . -}}{{- if contains $n .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name $n | trunc 63 | trimSuffix "-" }}{{- end -}}{{- end -}}
{{- end -}}
{{- define "neurouter-core.labels" -}}
app.kubernetes.io/name: {{ include "neurouter-core.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
{{- define "neurouter-core.selectorLabels" -}}
app.kubernetes.io/name: {{ include "neurouter-core.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "neurouter-core.image" -}}{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}{{- end -}}
{{- define "neurouter-core.serviceAccountName" -}}{{ if .Values.serviceAccount.create }}{{ .Values.serviceAccount.name | default (include "neurouter-core.fullname" .) }}{{ else }}{{ .Values.serviceAccount.name | default "default" }}{{ end }}{{- end -}}
{{- define "neurouter-core.dbSecret" -}}{{ .Values.database.existingSecret | default (printf "%s-db" (include "neurouter-core.fullname" .)) }}{{- end -}}
{{- define "neurouter-core.cryptoSecret" -}}{{ .Values.crypto.existingSecret | default (printf "%s-crypto" (include "neurouter-core.fullname" .)) }}{{- end -}}
{{- define "neurouter-core.executorSecret" -}}{{ .Values.executor.token.existingSecret | default (printf "%s-executor" (include "neurouter-core.fullname" .)) }}{{- end -}}
{{- define "neurouter-core.executorSelectorLabels" -}}
app.kubernetes.io/name: {{ include "neurouter-core.name" . }}-executor
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "neurouter-core.oidcSecret" -}}{{ .Values.oidc.existingSecret | default (printf "%s-oidc" (include "neurouter-core.fullname" .)) }}{{- end -}}

{{/* env + envFrom shared by the Deployment and the migration Job */}}
{{- define "neurouter-core.env" -}}
- name: DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ include "neurouter-core.dbSecret" . }}, key: DATABASE_URL } }
{{- if or .Values.database.auditUrl .Values.database.existingSecret }}
- name: AUDIT_DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ include "neurouter-core.dbSecret" . }}, key: AUDIT_DATABASE_URL, optional: true } }
{{- end }}
- name: NEUROUTER_MASTER_KEYS
  valueFrom: { secretKeyRef: { name: {{ include "neurouter-core.cryptoSecret" . }}, key: NEUROUTER_MASTER_KEYS } }
- name: NEUROUTER_ACTIVE_KEY_ID
  valueFrom: { secretKeyRef: { name: {{ include "neurouter-core.cryptoSecret" . }}, key: NEUROUTER_ACTIVE_KEY_ID } }
- name: HASH_PEPPER
  valueFrom: { secretKeyRef: { name: {{ include "neurouter-core.cryptoSecret" . }}, key: HASH_PEPPER } }
{{- if .Values.oidc.issuer }}
- name: OIDC_CLIENT_SECRET
  valueFrom: { secretKeyRef: { name: {{ include "neurouter-core.oidcSecret" . }}, key: OIDC_CLIENT_SECRET } }
{{- end }}
{{- if ne .Values.executor.mode "off" }}
- name: NEUROUTER_EXECUTOR_TOKEN
  valueFrom: { secretKeyRef: { name: {{ include "neurouter-core.executorSecret" . }}, key: NEUROUTER_EXECUTOR_TOKEN } }
{{- end }}
{{- range $p, $var := dict "openai" "OPENAI_API_KEY" "anthropic" "ANTHROPIC_API_KEY" "gemini" "GEMINI_API_KEY" }}
{{- with (index $.Values $p).existingSecret }}
- name: {{ $var }}
  valueFrom: { secretKeyRef: { name: {{ . }}, key: {{ $var }} } }
{{- end }}
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* hardened container securityContext for the executor (§10.6 L3) */}}
{{- define "neurouter-core.executorSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
capabilities: { drop: ["ALL"] }
seccompProfile: { type: RuntimeDefault }
{{- end -}}
