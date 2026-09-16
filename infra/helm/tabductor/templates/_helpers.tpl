{{- define "tabductor.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tabductor.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "tabductor.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tabductor.labels" -}}
app.kubernetes.io/name: {{ include "tabductor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
