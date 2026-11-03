// Deploy pipeline (Jenkins on hserver): test -> build -> migrate -> deploy.
// Shared library: github.com/hangelify/jenkins-budget (vars/deployApp.groovy).
@Library('jenkins-lib') _
deployApp(app: 'budget', service: 'api', image: 'budget-api', migrate: true)
