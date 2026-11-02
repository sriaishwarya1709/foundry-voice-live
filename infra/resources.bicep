param location string
param tags object
param resourceToken string
param principalId string
param principalType string
param modelName string
param modelVersion string
param modelCapacity int
param agentName string
param deployWebApp bool
@secure()
param demoAccessCode string

var accountName = 'aif-voicelive-${resourceToken}'
var projectName = 'voice-live-project'

// Built-in role definition IDs
var foundryUserRoleId = '53ca6127-db72-4b80-b1b0-d745d6d5456d' // Foundry User (formerly Azure AI User)
var cognitiveServicesUserRoleId = 'a97b65f3-24c7-4388-baec-2e87135dc908'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

// ---------------------------------------------------------------------------
// Microsoft Foundry resource + project + model deployment
// ---------------------------------------------------------------------------
resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: accountName
    allowProjectManagement: true
    publicNetworkAccess: 'Enabled'
    // Keyless only: Voice Live agent mode requires Microsoft Entra ID anyway.
    disableLocalAuth: true
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: account
  name: projectName
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'Voice Live demo project'
    description: 'Foundry prompt agent exposed through Azure Speech Voice Live.'
  }
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: account
  name: modelName
  // Creating the project and a deployment in parallel causes RequestConflict.
  dependsOn: [project]
  sku: {
    name: 'GlobalStandard'
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
  }
}

// Deploying user: create agents + open Voice Live sessions locally
resource userFoundryRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId)) {
  name: guid(account.id, principalId, foundryUserRoleId)
  scope: account
  properties: {
    principalId: principalId
    principalType: principalType
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryUserRoleId)
  }
}

resource userCogUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId)) {
  name: guid(account.id, principalId, cognitiveServicesUserRoleId)
  scope: account
  properties: {
    principalId: principalId
    principalType: principalType
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRoleId)
  }
}

// ---------------------------------------------------------------------------
// Optional hosting: Azure Container Apps
// ---------------------------------------------------------------------------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (deployWebApp) {
  name: 'log-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = if (deployWebApp) {
  name: 'acrvl${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (deployWebApp) {
  name: 'id-voicelive-${resourceToken}'
  location: location
  tags: tags
}

resource appAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployWebApp) {
  name: guid(registry.id, appIdentity.id, acrPullRoleId)
  scope: registry
  properties: {
    principalId: appIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

resource appFoundryRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployWebApp) {
  name: guid(account.id, appIdentity.id, foundryUserRoleId)
  scope: account
  properties: {
    principalId: appIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryUserRoleId)
  }
}

resource appCogUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployWebApp) {
  name: guid(account.id, appIdentity.id, cognitiveServicesUserRoleId)
  scope: account
  properties: {
    principalId: appIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRoleId)
  }
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = if (deployWebApp) {
  name: 'cae-voicelive-${resourceToken}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs!.properties.customerId
        sharedKey: logs!.listKeys().primarySharedKey
      }
    }
  }
}

var accessCodeSecret = empty(demoAccessCode) ? [] : [
  {
    name: 'demo-access-code'
    value: demoAccessCode
  }
]
var accessCodeEnv = empty(demoAccessCode) ? [] : [
  {
    name: 'DEMO_ACCESS_CODE'
    secretRef: 'demo-access-code'
  }
]

resource webApp 'Microsoft.App/containerApps@2024-03-01' = if (deployWebApp) {
  name: 'ca-voicelive-${resourceToken}'
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${appIdentity.id}': {} }
  }
  dependsOn: [appAcrPull]
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8000
        transport: 'auto'
      }
      registries: [
        {
          server: registry!.properties.loginServer
          identity: appIdentity.id
        }
      ]
      secrets: accessCodeSecret
    }
    template: {
      containers: [
        {
          name: 'web'
          // Placeholder; `azd deploy` swaps in the real image.
          image: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat([
            { name: 'AZURE_CLIENT_ID', value: appIdentity!.properties.clientId }
            { name: 'AZURE_VOICELIVE_ENDPOINT', value: 'https://${accountName}.services.ai.azure.com/' }
            { name: 'FOUNDRY_PROJECT_NAME', value: projectName }
            { name: 'AGENT_NAME', value: agentName }
          ], accessCodeEnv)
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

output accountName string = account.name
output projectName string = project.name
output voiceLiveEndpoint string = 'https://${accountName}.services.ai.azure.com/'
output projectEndpoint string = 'https://${accountName}.services.ai.azure.com/api/projects/${projectName}'
output modelDeploymentName string = modelDeployment.name
output registryEndpoint string = deployWebApp ? registry!.properties.loginServer : ''
output webUrl string = deployWebApp ? 'https://${webApp!.properties.configuration.ingress.fqdn}' : ''
