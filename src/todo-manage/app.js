"use strict";

const { DocumentClient} = require("aws-sdk/clients/dynamodb");
const { v4: uuidV4 } = require("uuid");

/** フラグでの削除日 */
const flagDeleteDate = 7;
/** 再設定追加日付 */
const resetAddDate = 3;
/** データ削除日 */
const dataDeleteDate = 7;

let tableName = "Todo";

exports.lambdaHandler = async () => {
  setTableName();
  await expiredTodo();
  await deleteTodo();
  return {
    statusCode: 200,
  };
};

/**
 * 期限切れのTodo
 * @description 期限切れのTodoに削除フラグを立てる
 * かつ、繰り返しのTodoの場合は未解決のコメントを切り出したTodoを新規作成する
 */
const expiredTodo = async () => {
  const dynamodbClient = getDynamoClient();

  try {
    let getParams = createGetParams();
    getParams.ExpressionAttributeValues = {
      ":value": 0,
    };
    const data = await dynamodbClient.query(getParams).promise();

    if (data.Count > 0) {
      // i週間前のDate
      const deleteLimit = new Date();
      deleteLimit.setDate(deleteLimit.getDate() - flagDeleteDate);
      const updateTodoList = data.Items.reduce((accumulator, currentValue) => {
        const updateDate = new Date(currentValue.targetAt);
        if (updateDate - deleteLimit < 0) {
          accumulator.push(currentValue);
        }
        return accumulator;
      }, []);

      const updateiSOString = new Date().toISOString();

      for (const updateTodo of updateTodoList) {
        const transactItems = [
          {
            Update: {
              TableName: getTableName(),
              Key: { id: updateTodo.id },
              UpdateExpression: "set #status = :delete",
              ExpressionAttributeNames: {
                "#status": "status",
              },
              ExpressionAttributeValues: {
                ":delete": 1,
              },
            },
          },
        ];

        // 繰り越しの場合
        if (updateTodo.carryOver) {
          // 未完了のタスク抜き出し
          const carryOverComment = {
            commentType: updateTodo.comment.commentType,
            freeComment: updateTodo.comment.freeComment,
            contentList: updateTodo.comment.contentList.filter(
              (content) => content.complete === false
            ),
          };

          // 未完了タスクが存在する場合
          if (carryOverComment.contentList.length > 0) {
            // 期限を再設定する
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + resetAddDate);

            transactItems.push({
              Put: {
                TableName: getTableName(),
                Item: {
                  id: uuidV4(),
                  status: updateTodo.status,
                  title: updateTodo.title,
                  comment: carryOverComment,
                  url: updateTodo.url,
                  targetAt: targetDate.toISOString(),
                  carryOver: updateTodo.carryOver,
                  createdAt: updateTodo.createdAt,
                  updatedAt: updateiSOString,
                  updatedUser: updateTodo.updatedUser,
                  owner: null,
                },
                ExpressionAttributeNames: {
                  "#id": "id",
                },
                ConditionExpression: "attribute_not_exists(#id)",
                ReturnValues: "NONE",
              },
            });
          }

          await dynamodbClient
            .transactWrite({
              TransactItems: transactItems,
            })
            .promise();
        }
      }
    }
  } catch (error) {
    console.log(error);
  }
};

/**
 * Todo削除
 * @description 削除フラグかつ、更新後一定期間が経ったアイテムを削除する
 */
const deleteTodo = async () => {
  const dynamodbClient = getDynamoClient();
  try {
    let getParams = createGetParams();
    getParams.ExpressionAttributeValues = {
      ":value": 1,
    };
    const todoList = await dynamodbClient.query(getParams).promise();
    // Todoなしの場合
    if (todoList.Count === 0) {
      return;
    }
    // データ削除対象の日時を決定
    const deleteLimit = new Date();
    deleteLimit.setDate(deleteLimit.getDate() - dataDeleteDate);

    // 削除対象のId取得
    const deleteTargetIds = todoList.Items.reduce(
      (accumulator, currentValue) => {
        const updateDate = new Date(currentValue.updatedAt);
        if (updateDate - deleteLimit < 0) {
          accumulator.push(currentValue.id);
        }
        return accumulator;
      },
      []
    );

    // 削除対象のアイテムを順に削除
    for (const deleteTargetId of deleteTargetIds) {
      const deleteParams = {
        TableName: getTableName(),
        Key: {
          id: deleteTargetId,
        },
      };
      await dynamodbClient.delete(deleteParams).promise();
    }
  } catch (error) {
    console.log(error);
  }
};

/**
 * GetParams作成
 * @returns GetParams
 */
const createGetParams = () => {
  return {
    TableName: getTableName(),
    KeyConditionExpression: "#key= :value",
    ExpressionAttributeNames: {
      "#key": "status",
    },
    IndexName: "SortByTargetAt",
  };
};

/**
 * DynamoClient取得
 * @returns DynamoClient
 */
const getDynamoClient = () => {
  if (process.env.AWS_SAM_LOCAL) {
    return new DocumentClient({
      endpoint: "http://host.docker.internal:62224",
      region: "us-fake-1",
      accessKeyId: "fake",
      secretAccessKey: "fake",
    });
  } else {
    return new DocumentClient();
  }
};

/**
 * テーブル名の設定
 */
const setTableName = () => {
  if (process.env.AWS_SAM_LOCAL) {
    tableName = "TodoTable";
  } else {
    tableName = process.env["tableName"];
  }
};

/**
 * テーブル名の取得
 */
const getTableName = () => {
  return tableName;
};
