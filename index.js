require('dotenv').config()
const express = require('express')
const { generateSlug } = require('random-word-slugs')
const { EC2Client, RunInstancesCommand, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { SSMClient, SendCommandCommand } = require('@aws-sdk/client-ssm');
const cors = require('cors')

const app = express()
const PORT = 9000

app.use(cors());
app.use(express.json())

const REGION = 'ap-south-1';
const INSTANCE_TYPE = 't2.micro';
const AMI_ID = 'ami-0a51a22a987dc45fd'; 
const SECURITY_GROUP_ID = 'sg-0b34e34d59a58cb23'; 

// Initialize EC2 and SSM clients
const ec2Client = new EC2Client({
    region: REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});
const ssmClient = new SSMClient({
    region: REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});


app.post('/api/v2/deploy', async (req, res) => {
    const { gitURL, framework, rootDirectory, buildCommand, startCommand, envVariables } = req.body;
    const projectSlug = generateSlug();

    try {
        console.log(`Creating machine`);

        // Step 1: Launch EC2 instance without specifying a key pair
        const instanceParams = {
            ImageId: AMI_ID,
            InstanceType: INSTANCE_TYPE,
            SecurityGroupIds: [SECURITY_GROUP_ID],
            MinCount: 1,
            MaxCount: 1,
            TagSpecifications: [{
                ResourceType: 'instance',
                Tags: [
                    { Key: 'Project', Value: 'DynamicDeployment' },
                    { Key: 'Name', Value: projectSlug }
                ]
            }],
            IamInstanceProfile: {
                Name: 'AmazonEC2RoleforSSM'
            }
        };

        const instanceCommand = new RunInstancesCommand(instanceParams);
        const instanceData = await ec2Client.send(instanceCommand);
        const instanceId = instanceData.Instances[0].InstanceId;
        console.log(`Instance created with ID: ${instanceId}`);

        res.json({ status: 'Deploying', data: { projectSlug, url: `IP address yet to be assigned`, instance_ID: instanceId } });

        // Wait for instance to be running (or add further checks here)
        await new Promise(resolve => setTimeout(resolve, 60000 * 3)); // wait for 3 minutes

        // Step 2: Use SSM to run setup commands on the instance
        const userDataScript = `
#!/bin/bash

# Update the system and install required packages
sudo yum update -y
sudo yum install -y git

# Clone the repository
git clone ${gitURL} /home/${projectSlug}/app

# Navigate to the app directory
cd /home/${projectSlug}/app/${rootDirectory}

# Create a .env file if environment variables are provided
if [ ! -z "${envVariables}" ]; then
    echo "Creating .env file with provided environment variables"
    cat <<EOT > .env
${envVariables}
EOT
fi

# Node.js setup
echo "Setting up Node.js project"
curl -sL https://rpm.nodesource.com/setup_16.x | sudo -E bash -
sudo yum install -y nodejs
sudo npm install -g yarn

# Run user-specified build command
if [ ! -z "${buildCommand}" ]; then
    echo "Running build command"
    ${buildCommand}
fi

# Start the application
echo "Starting the application with start command"
nohup ${startCommand} > /home/${projectSlug}/app/logs.log 2>&1 &
`;

        const ssmCommandParams = {
            DocumentName: "AWS-RunShellScript",
            Parameters: { commands: [userDataScript] },
            InstanceIds: [instanceId],
        };

        const ssmCommand = new SendCommandCommand(ssmCommandParams);
        await ssmClient.send(ssmCommand);
        console.log(`Commands sent to EC2 instance with ID: ${instanceId}`);

        const describeInstancesCommand = new DescribeInstancesCommand({
            InstanceIds: [instanceId]
        });

        const describeInstancesResponse = await ec2Client.send(describeInstancesCommand);
        const publicIp = describeInstancesResponse.Reservations[0].Instances[0].PublicIpAddress;
        console.log(publicIp);
    } catch (error) {
        console.error('Error creating or setting up EC2 instance:', error);
    }
});

app.get('/api/v2/status', async (req, res) => {
    try {
        const describeInstancesCommand = new DescribeInstancesCommand({
            InstanceIds: [req.query.instanceID]
        });

        const describeInstancesResponse = await ec2Client.send(describeInstancesCommand);
        const publicIp = describeInstancesResponse.Reservations[0].Instances[0].PublicIpAddress;
        res.json({
            status: "Deployment Complete!",
            projectUrl: publicIp
        });
    } catch (error) {
        console.log(error);
        return res.json(error);
    }
});

app.listen(PORT, () => console.log(`API Server Running on ${PORT}`));
