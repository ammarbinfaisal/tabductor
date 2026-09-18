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

{{- define "tabductor.configSecret" -}}
{{- default (printf "%s-config" (include "tabductor.fullname" .)) .Values.existingConfigSecret -}}
{{- end }}

{{- define "tabductor.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end }}
