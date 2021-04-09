const { Octokit } = require("@octokit/rest");
const core = require("@actions/core");
const { request } = require("@octokit/request");
const { withCustomRequest } = require("@octokit/graphql");
const env = process.env;

// Check if version is not of form v0.0.0 or 0.0.0
function isDeletableVersion(version) {
    var releasePattern = /[v]?[0-9]+\.[0-9]+\.[0-9]+/g;
    var result = version.match(releasePattern);
    if (result != null && result == version) {
        return false
    }
    return true
}

function isOlderThanNumberOfDays(package, noOfDays, package_name) {
    const createdDate = new Date(package.created_at);
    const today = new Date();
    var time_difference = today.getTime() - createdDate.getTime();  
    //calculate days difference by dividing total milliseconds in a day  
    var days_difference = time_difference / (1000 * 60 * 60 * 24);  
    console.log(`package ${package_name} of version ${package.name} is ${days_difference} days older`)
    if (days_difference > noOfDays) {
        return true
    }
    return false
}

function getPackagesToBeDeleted(packages, noOfDays, package_name)  {
    var result = []
    for (var i=0; i < packages.length; i++) {
        console.log(`Package ${package_name} of version ${packages[i].name}:
         isDeletableVersion: ${isDeletableVersion(packages[i].name)}
         isOlderThanNumberOfDays: ${isOlderThanNumberOfDays(packages[i], noOfDays, package_name)}
        `)
        if (isDeletableVersion(packages[i].name) && isOlderThanNumberOfDays(packages[i], noOfDays, package_name)) {
            result.push(packages[i]);
        }
    }
    return result
}

async function findAndDeletePackageVersions(org, package_type, package_name, noOfDays, token) {
    const octokit = new Octokit({ auth: token });

    // Handle response
    octokit.hook.after("request", async (response, options) => {
        if (response.data.length < 1) {
            console.log(`Package ${package_name} doesn't contain any version.`)
            return
        }
        var packages = getPackagesToBeDeleted(response.data, noOfDays, package_name)
        if (packages.length < 1) {
            console.log(`Package ${package_name} doesn't contain any version older than ${noOfDays} days.`)
            return
        } else {
            console.log(`package versions to be deleted for ${package_name}:`);
            for(i=0; i< packages.length; i++) {
                console.log(packages[i].name);
            }
        }
        for (var i=0; i < packages.length; i++) {
            deletePackageVersion(org, package_type, package_name, packages[i].name,  packages[i].id, token);
        }
    });

    // Handle error
    octokit.hook.error("request", async (error, options) => {
        core.setFailed(error.message);
        return;
    });

    if (org === null || org === "") {
        await octokit.paginate('GET /user/packages/{package_type}/{package_name}/versions', {
            package_type: package_type,
            package_name: package_name
        });
    } else {
        await octokit.paginate('GET /orgs/{org}/packages/{package_type}/{package_name}/versions', {
            org: org,
            package_type: package_type,
            package_name: package_name
        });
    }
}

async function deletePackageVersion(org, package_type, package_name, version, version_id, token) {
    const octokit = new Octokit({ auth: token });

    // Handle response
    octokit.hook.after("request", async (response, options) => {
        console.log(`Deleted version ${version} successfully`);
    });

    // Handle error
    octokit.hook.error("request", async (error, options) => {
        if (error != null) {
            console.log(`Unable to delete version ${version}. Error: ${error}`)
            core.setFailed(error);
            return;
        }
    });

    if (org === null || org === "") {
        await octokit.request('DELETE /user/packages/{package_type}/{package_name}/versions/{version_id}', {
            package_type: package_type,
            package_name: package_name,
            version_id: version_id
        });
    } else {
        await octokit.request('DELETE /orgs/{org}/packages/{package_type}/{package_name}/versions/{version_id}', {
            org: org,
            package_type: package_type,
            package_name: package_name,
            version_id: version_id
        });
    }
}

// getPackageNames searches packages for a given repo and returns the list of package names.
async function getPackageNames(owner, repo, package_type, token) {
    var packages = []
    let continuePagination = false
    let afterId = ""
    do {
        const query = `query {
            repository(owner: "${owner}", name: "${repo}") {
              name
              packages(first: 20, after: "${afterId}", packageType: ${package_type.toUpperCase()}) {
                totalCount
                nodes {
                  name
                  id
                }
                pageInfo {
                    endCursor
                    hasNextPage
                }
              }
            }
        }`;
        try {
            const myRequest = request.defaults({
                headers: {
                    authorization: `token ${token}`,
                },
                request: {
                  hook(request, options) {
                    return request(options);
                  },
                },
            });
            const myGraphql = withCustomRequest(myRequest);
            const result = await myGraphql(query);
            if (result.repository.packages.nodes == null) {
                console.log(`No packages found in the org`);
                return
            }
            packages.push(...result.repository.packages.nodes);
            continuePagination = result.repository.packages.pageInfo.hasNextPage;
            afterId = result.repository.packages.pageInfo.endCursor;
        } catch (error) {
            core.setFailed(error);
            return;
        }
    } while(continuePagination)

    var packageNames = [];
    for(i = 0; i < packages.length; i++) {
        packageNames.push(packages[i].name)
    }
    return packageNames;
}

async function run() {
    const org = core.getInput("ORG");
    const package_type = core.getInput("PACKAGE_TYPE");
    const token = core.getInput("TOKEN");
    var noOfDays = core.getInput("OLDER_THAN_NUMBER_OF_DAYS");
    const owner = env.GITHUB_REPOSITORY.split("/")[0];
    const repo = env.GITHUB_REPOSITORY.split("/")[1];

    if (!Number.isInteger((Number(noOfDays))) || noOfDays == "") {
        core.setFailed(`noOfDays ${noOfDays} should be a valid integer`)
        return
    }

    if (noOfDays < 1) {
        core.setFailed(`noOfDays ${noOfDays} cannot be less than 1`)
        return
    }

    var packageNames = await getPackageNames(owner, repo, package_type, token)
    for (i = 0; i< packageNames.length; i++) {
        findAndDeletePackageVersions(org, package_type, packageNames[i], noOfDays, token);
    }
}

run();
